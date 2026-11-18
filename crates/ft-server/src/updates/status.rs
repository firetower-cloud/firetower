//! Checking for a release, and describing where the fleet stands against it.

use super::store::Checked;
use super::{
    channel, check, client, deploy, version, ControlPlaneTarget, FileChoice, HostTarget, Release,
    UpdateStatus, UpdaterView, Updates, UpgradePlan,
};
use crate::AppState;
use anyhow::{Context, Result};
use semver::Version;
use std::time::Duration;

/// How often the feed is asked, unprompted.
pub const EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// The setting that remembers which release somebody was told about.
const NOTIFIED: &str = "updates.notified";

/// Ask the feed, remember the answer, and say so once if it is new.
///
/// The agents' own publishers are asked on the same pass. They are a different
/// question with the same shape — what is published, against what is installed
/// — and one timer asking both is one thing to reason about instead of two.
/// Nothing here depends on the answer, so a publisher being down is a warning
/// inside [`super::agents::Releases::refresh`] and not a failed check.
pub async fn check(state: &AppState) -> Result<Checked> {
    let updates = &state.updates;
    updates
        .agent_releases
        .refresh(&updates.http, &updates.agent_feeds)
        .await;

    // Which channel this installation is on decides which release it is
    // offered, so the channel manifest is read on this pass and the feed is
    // asked second — for the notes of whatever the manifest named.
    let on = channel::running(updates, None).await.channel;
    let manifest = channel::refresh(state).await;

    let found = match what_to_offer(&manifest, on) {
        Offered::Pinned(version) => described(updates, &version).await,
        // Absence is the bootstrap: nothing has been published yet, so this
        // installation follows the newest release exactly as it did before
        // channels existed.
        Offered::TheNewestRelease => match check::latest(&updates.http, &updates.feed).await {
            Ok(latest) => described(updates, &latest.version).await,
            Err(e) => {
                tracing::warn!("checking for a release: {e:#}");
                nothing_new(format!("{e:#}"))
            }
        },
        // A read that went wrong moves nothing. `record_check` keeps the
        // version the last good check found, so the screen holds still and
        // says why rather than reporting a version nobody published.
        Offered::Stop(why) => nothing_new(why),
    };
    updates.store.record_check(&found).await?;

    if let Some(latest) = found.latest_version.as_deref().and_then(version::parse) {
        if version::is_newer(&latest, &version::current()) {
            tell_once(state, &latest).await;
        }
    }
    Ok(found)
}

/// What a check offers, once the channel manifest has been read.
#[derive(Debug, PartialEq, Eq)]
enum Offered {
    /// The version this installation's channel holds.
    Pinned(Version),
    /// Nothing is published yet, so follow the newest release as this
    /// installation did before channels existed. **Only absence.**
    TheNewestRelease,
    /// Change nothing, and say why.
    Stop(String),
}

/// Which of the three a read means.
///
/// The whole of the rule in one place, so it can be interrogated: only
/// [`channel::Read::Absent`] is the bootstrap, and every other way a read can
/// go wrong stops. A rate limit falling through to the newest release would
/// offer a general-access installation whatever beta is on.
fn what_to_offer(manifest: &channel::Read, on: channel::Channel) -> Offered {
    match manifest {
        channel::Read::Absent => Offered::TheNewestRelease,
        // Explicit, rather than left to the catch-all below: the one state
        // that must never fall through to "follow the newest release" is the
        // one where the document was there and is not any more.
        channel::Read::Vanished(why) => Offered::Stop(format!("{why}. Nothing is being moved.")),
        channel::Read::Found(document) => match document
            .pin(channel::Package::ControlPlane, on)
            .and_then(version::parse)
        {
            Some(pinned) => Offered::Pinned(pinned),
            None => Offered::Stop(format!(
                "the channel manifest names no control plane version for {}. Nothing is being \
                 moved.",
                on.name()
            )),
        },
        failed => Offered::Stop(format!(
            "{}. Nothing is being moved.",
            failed
                .problem()
                .unwrap_or("the channel manifest did not read")
        )),
    }
}

/// A check that found nothing to move to, and the reason. The version the
/// last good check found is kept — see `Store::record_check`.
fn nothing_new(why: String) -> Checked {
    Checked {
        checked_at: chrono::Utc::now(),
        latest_version: None,
        published_at: None,
        notes_url: None,
        notes: None,
        cli_minimum: None,
        error: Some(why),
    }
}

/// One version, with whatever the feed can say about it.
///
/// The version is the answer; its notes are a nicety. A release that has
/// fallen off the feed's page — routine for a general access that has skipped
/// versions — is still the release being offered, so a feed that cannot
/// supply the notes is a warning beside the version rather than a check that
/// found nothing.
async fn described(updates: &Updates, version: &Version) -> Checked {
    let found = match check::releases(&updates.http, &updates.feed).await {
        Ok(body) => Ok(check::pick_version(&body, version)),
        Err(e) => Err(e),
    };
    let cli_minimum = check::cli_minimum(&updates.http, &updates.feed, version).await;
    let (release, error) = match found {
        Ok(release) => (release, None),
        Err(e) => {
            tracing::warn!("reading the releases feed: {e:#}");
            (None, Some(format!("{e:#}")))
        }
    };
    Checked {
        checked_at: chrono::Utc::now(),
        latest_version: Some(version.to_string()),
        published_at: release.as_ref().and_then(|r| r.published_at),
        notes_url: release.as_ref().and_then(|r| r.notes_url.clone()),
        notes: release.and_then(|r| r.notes),
        cli_minimum,
        error,
    }
}

/// Every few hours, for as long as the control plane runs.
pub async fn watch(state: AppState) {
    // Not immediately: start-up has enough to do, and a control plane that
    // was just recreated by an upgrade would otherwise ask GitHub before its
    // own fleet has reconnected.
    tokio::time::sleep(Duration::from_secs(20)).await;
    loop {
        if let Err(e) = check(&state).await {
            tracing::warn!("recording the update check: {e:#}");
        }
        tokio::time::sleep(EVERY).await;
    }
}

/// One notification per release, when somebody asked to be told.
async fn tell_once(state: &AppState, latest: &Version) {
    if !state.updates.notify.configured() {
        return;
    }
    let told = state.accounts.setting(NOTIFIED).await.ok().flatten();
    if told.as_deref() == Some(latest.to_string().as_str()) {
        return;
    }
    state.updates.notify.say(
        &format!("Firetower {latest} is available"),
        &format!(
            "This install is on {}. Open Updates to review and upgrade.",
            version::current()
        ),
        Some(format!(
            "{}/updates",
            state.public_url.trim_end_matches('/')
        )),
    );
    let _ = state
        .accounts
        .set_setting(NOTIFIED, &latest.to_string())
        .await;
}

/// The whole picture: what is newest, what is behind, what can be moved.
pub async fn status(state: &AppState) -> Result<UpdateStatus> {
    let updates = &state.updates;
    let current = version::current();
    let checked = updates.store.last_check().await?;

    let latest_version = checked
        .as_ref()
        .and_then(|c| c.latest_version.as_deref())
        .and_then(version::parse);
    let latest = checked.as_ref().and_then(|c| {
        latest_version.as_ref().map(|v| Release {
            version: v.to_string(),
            published_at: c.published_at,
            notes_url: c.notes_url.clone(),
            notes: c.notes.clone(),
            cli_minimum: c.cli_minimum.clone(),
        })
    });
    let newer = latest_version
        .as_ref()
        .is_some_and(|l| version::is_newer(l, &current));

    let hosts = state.db.hosts().await?;

    let (updater, answered) = updater_view(updates).await;
    let control_plane = ControlPlaneTarget {
        version: current.to_string(),
        upgradable: newer && updater.reachable,
        reason: if !newer {
            None
        } else {
            updater.problem.clone()
        },
        updater,
        // Answered for the caller in `api::updates`, which is the layer that
        // knows who is asking. False here so a path that forgets says no.
        may_upgrade: false,
    };

    let mut targets = Vec::new();
    for host in hosts.iter() {
        let online = state.fleet.is_connected(&host.id).await;
        let behind = match (&host.worker_version, &latest_version) {
            (Some(theirs), Some(latest)) => version::parse(theirs)
                .map(|v| version::is_newer(latest, &v))
                .unwrap_or(true),
            (None, Some(_)) => true,
            (_, None) => false,
        };
        // Reinstalled over ssh, which needs the machine and not the worker —
        // so a worker that is behind is upgradable whether or not it is
        // connected right now.
        let (upgradable, reason) = (behind, (!behind).then(|| "up to date".to_string()));
        targets.push(HostTarget {
            host_id: host.id.as_str().to_string(),
            name: host.name.clone(),
            version: host.worker_version.clone(),
            online,
            drained: host.drained,
            upgradable,
            may_upgrade: false,
            reason,
            sessions: state.db.live_sessions_on(&host.id).await?,
        });
    }

    let hosts_behind = targets.iter().any(|t| t.upgradable);
    let active_run = updates
        .store
        .active_runs()
        .await?
        .into_iter()
        .next()
        .map(|r| r.id);

    Ok(UpdateStatus {
        current: current.to_string(),
        latest,
        checked_at: checked.as_ref().map(|c| c.checked_at),
        check_error: checked.and_then(|c| c.error),
        update_available: newer || hosts_behind,
        control_plane,
        hosts: targets,
        active_run,
        // The updater was asked once, above, and this is the other half of
        // the same answer.
        channel: channel::status(state, answered.as_ref()).await,
    })
}

/// What the updater says, and what it said — the status itself comes back
/// too, because the channel is read out of the same answer and asking twice
/// would be two round trips for one fact.
async fn updater_view(updates: &Updates) -> (UpdaterView, Option<ft_updater_api::Status>) {
    match &updates.updater {
        Err(absent) => (
            UpdaterView {
                configured: matches!(absent, client::Absent::NoToken),
                reachable: false,
                version: None,
                api_version: None,
                problem: Some(absent.explain()),
            },
            None,
        ),
        Ok(updater) => match tokio::time::timeout(Duration::from_secs(4), updater.status()).await {
            Ok(Ok(status)) => (
                UpdaterView {
                    configured: true,
                    reachable: true,
                    version: Some(status.version.clone()),
                    api_version: Some(status.api_version),
                    problem: status
                        .busy
                        .as_ref()
                        .map(|_| "the updater is busy with an earlier job".to_string()),
                },
                Some(status),
            ),
            Ok(Err(e)) => (
                UpdaterView {
                    configured: true,
                    reachable: false,
                    version: None,
                    api_version: None,
                    problem: Some(format!("the updater is not answering: {e:#}")),
                },
                None,
            ),
            Err(_) => (
                UpdaterView {
                    configured: true,
                    reachable: false,
                    version: None,
                    api_version: None,
                    problem: Some("the updater is not answering".into()),
                },
                None,
            ),
        },
    }
}

/// What moving the control plane to `to` would do to the deployment's files.
///
/// `control_plane` says whether it is one of the targets at all. When it is
/// not there is nothing to answer: no deployment file is written for a worker
/// upgrade, and the updater — the only way to read those files — has no part
/// in one. Asking it anyway is what used to make a deployment with no
/// `FIRETOWER_UPDATER_TOKEN` refuse to upgrade a worker, with a message about
/// a container that was not involved.
pub async fn plan(state: &AppState, to: &Version, control_plane: bool) -> Result<UpgradePlan> {
    if !control_plane {
        return Ok(UpgradePlan {
            version: to.to_string(),
            files: Vec::new(),
            env_missing: Vec::new(),
            updater_upgrade: false,
            channel_change: None,
        });
    }

    let updates = &state.updates;
    let updater = updates
        .updater
        .as_ref()
        .map_err(|absent| anyhow::anyhow!("{}", absent.explain()))?;
    let local = updater.deploy_files().await?;
    let from = version::current();

    let mut files = Vec::new();
    for name in deploy::FILES {
        let old = check::deploy_file(&updates.http, &updates.feed, &from, name).await?;
        let new = check::deploy_file(&updates.http, &updates.feed, to, name).await?;
        let here = local
            .files
            .iter()
            .find(|f| f.name == name)
            .and_then(|f| f.content.as_deref());
        files.push(deploy::plan(deploy::Copies {
            name,
            local: here,
            old: old.as_deref(),
            new: new.as_deref(),
        }));
    }

    let old_example =
        check::deploy_file(&updates.http, &updates.feed, &from, ".env.example").await?;
    let new_example = check::deploy_file(&updates.http, &updates.feed, to, ".env.example").await?;
    let env_missing = match new_example {
        Some(new) => deploy::env_missing(old_example.as_deref(), &new, &local.env_keys),
        None => Vec::new(),
    };

    let updater_upgrade = match updater.status().await {
        Ok(status) => version::parse(&status.version).is_none_or(|v| v != *to),
        Err(_) => true,
    };

    Ok(UpgradePlan {
        version: to.to_string(),
        files,
        env_missing,
        updater_upgrade,
        channel_change: None,
    })
}

/// The files a run will write, from the plan and what was chosen about it.
///
/// Fetched again rather than carried from the plan request, so what is
/// written is the release's file and not something a browser sent back.
pub async fn files_to_write(
    state: &AppState,
    to: &Version,
    choices: &[FileChoice],
) -> Result<Vec<ft_updater_api::FileWrite>> {
    // Only reached for a run that moves the control plane — `create_run`
    // leaves the plan empty otherwise — so the full plan is the right one.
    let planned = plan(state, to, true).await?;
    files_from_plan(state, to, planned, choices).await
}

/// The same, for a caller that has the plan already. A channel switch needs
/// both halves and there is no reason to ask the release for its files twice.
pub async fn files_from_plan(
    state: &AppState,
    to: &Version,
    planned: UpgradePlan,
    choices: &[FileChoice],
) -> Result<Vec<ft_updater_api::FileWrite>> {
    let mut writes = Vec::new();
    for file in planned.files {
        let chosen = choices.iter().find(|c| c.name == file.name);
        let write = file.verdict.writes()
            || (file.verdict == deploy::FileVerdict::Edited && chosen.is_some_and(|c| c.replace));
        if !write {
            continue;
        }
        let content = check::deploy_file(&state.updates.http, &state.updates.feed, to, &file.name)
            .await?
            .with_context(|| format!("{} vanished from the release", file.name))?;
        writes.push(ft_updater_api::FileWrite {
            name: file.name,
            content,
        });
    }
    Ok(writes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(general: &str, beta: &str) -> channel::Manifest {
        let channel::Read::Found(manifest) = channel::read(&format!(
            r#"{{"schema_version":1,"control_plane":{{"beta":"{beta}","general":"{general}"}}}}"#
        )) else {
            panic!("a document")
        };
        manifest
    }

    /// Which release an installation is offered is its channel's, and a read
    /// that went wrong changes nothing. Four of these five would be caught by
    /// nothing else: falling through to the newest release is exactly what
    /// the old behaviour was, so it looks right until a general-access
    /// installation is offered a beta.
    #[test]
    fn only_absence_falls_back_to_the_newest_release() {
        let manifest = channel::Read::Found(document("0.54.1", "0.56.0"));
        assert_eq!(
            what_to_offer(&manifest, channel::Channel::General),
            Offered::Pinned(Version::new(0, 54, 1))
        );
        assert_eq!(
            what_to_offer(&manifest, channel::Channel::Beta),
            Offered::Pinned(Version::new(0, 56, 0)),
            "the same document, a different channel, a different release"
        );

        assert_eq!(
            what_to_offer(&channel::Read::Absent, channel::Channel::General),
            Offered::TheNewestRelease,
            "the bootstrap case, and the only one"
        );

        for failed in [
            channel::Read::Vanished("it has gone".into()),
            channel::Read::Unreadable("rate limited".into()),
            channel::Read::Malformed("not this document".into()),
            channel::Read::Incomplete("no version in it".into()),
        ] {
            match what_to_offer(&failed, channel::Channel::General) {
                Offered::Stop(why) => {
                    assert!(why.contains("Nothing is being moved"), "{why}");
                    assert!(
                        why.contains(failed.problem().unwrap()),
                        "it says which one it was: {why}"
                    );
                }
                other => panic!("{failed:?} must stop, not {other:?}"),
            }
        }
    }

    /// A document that reads but names nothing for this package is not a
    /// reason to go back to the feed either.
    #[test]
    fn a_document_naming_no_version_stops() {
        let only_desktop = channel::read(
            r#"{"schema_version":1,"control_plane":{"beta":"0.1.0","general":"0.1.0"}}"#,
        );
        assert!(matches!(
            what_to_offer(&only_desktop, channel::Channel::General),
            Offered::Pinned(_)
        ));
        assert!(matches!(
            what_to_offer(
                &channel::Read::Incomplete("names no control_plane.general version".into()),
                channel::Channel::General
            ),
            Offered::Stop(_)
        ));
    }

    /// Nothing found is nothing found, and the version the last check knew
    /// stays — `record_check` coalesces it.
    #[test]
    fn a_check_that_found_nothing_names_no_version() {
        let said = nothing_new("the channel manifest could not be fetched".into());
        assert!(said.latest_version.is_none(), "never a zero, never a guess");
        assert!(said.error.is_some());
    }
}
