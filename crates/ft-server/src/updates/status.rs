//! Checking for a release, and describing where the fleet stands against it.

use super::store::Checked;
use super::{
    check, client, deploy, version, ControlPlaneTarget, FileChoice, HostTarget, Release,
    TargetKind, UpdateStatus, UpdaterView, Updates, UpgradePlan,
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
pub async fn check(state: &AppState) -> Result<Checked> {
    let updates = &state.updates;
    let found = match check::latest(&updates.http, &updates.feed).await {
        Ok(latest) => {
            let cli_minimum =
                check::cli_minimum(&updates.http, &updates.feed, &latest.version).await;
            Checked {
                checked_at: chrono::Utc::now(),
                latest_version: Some(latest.version.to_string()),
                published_at: latest.published_at,
                notes_url: latest.notes_url,
                notes: latest.notes,
                cli_minimum,
                error: None,
            }
        }
        Err(e) => {
            tracing::warn!("checking for a release: {e:#}");
            Checked {
                checked_at: chrono::Utc::now(),
                latest_version: None,
                published_at: None,
                notes_url: None,
                notes: None,
                cli_minimum: None,
                error: Some(format!("{e:#}")),
            }
        }
    };
    updates.store.record_check(&found).await?;

    if let Some(latest) = found.latest_version.as_deref().and_then(version::parse) {
        if version::is_newer(&latest, &version::current()) {
            tell_once(state, &latest).await;
        }
    }
    Ok(found)
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
    let local = hosts.iter().find(|h| h.compute == ft_core::Compute::Local);
    let local_sessions = match local {
        Some(h) => state.db.live_sessions_on(&h.id).await?,
        None => Vec::new(),
    };

    let updater = updater_view(updates).await;
    let control_plane = ControlPlaneTarget {
        version: current.to_string(),
        upgradable: newer && updater.reachable,
        reason: if !newer {
            None
        } else {
            updater.problem.clone()
        },
        sessions: local_sessions,
        updater,
    };

    let mut targets = Vec::new();
    for host in hosts
        .iter()
        .filter(|h| h.compute != ft_core::Compute::Local)
    {
        let kind = match &host.compute {
            ft_core::Compute::Container { .. } => TargetKind::Container,
            ft_core::Compute::Server {
                container: Some(_), ..
            } => TargetKind::Container,
            _ => TargetKind::Binary,
        };
        let online = state.fleet.is_connected(&host.id).await;
        let behind = match (&host.worker_version, &latest_version) {
            (Some(theirs), Some(latest)) => version::parse(theirs)
                .map(|v| version::is_newer(latest, &v))
                .unwrap_or(true),
            (None, Some(_)) => true,
            (_, None) => false,
        };
        let (upgradable, reason) = match kind {
            TargetKind::Binary => (
                false,
                Some(
                    "installed by hand — Firetower doesn't know how, so it won't touch it. \
                     `firetower worker install` on that machine moves it into a container it can."
                        .to_string(),
                ),
            ),
            TargetKind::Container if !online => (
                false,
                Some("not connected; it has to answer before it can be recreated".into()),
            ),
            TargetKind::Container => (behind, (!behind).then(|| "up to date".to_string())),
        };
        targets.push(HostTarget {
            host_id: host.id.as_str().to_string(),
            name: host.name.clone(),
            kind,
            version: host.worker_version.clone(),
            online,
            drained: host.drained,
            upgradable,
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
    })
}

async fn updater_view(updates: &Updates) -> UpdaterView {
    match &updates.updater {
        Err(absent) => UpdaterView {
            configured: matches!(absent, client::Absent::NoToken),
            reachable: false,
            version: None,
            api_version: None,
            problem: Some(absent.explain()),
        },
        Ok(updater) => match tokio::time::timeout(Duration::from_secs(4), updater.status()).await {
            Ok(Ok(status)) => UpdaterView {
                configured: true,
                reachable: true,
                version: Some(status.version),
                api_version: Some(status.api_version),
                problem: status
                    .busy
                    .map(|_| "the updater is busy with an earlier job".to_string()),
            },
            Ok(Err(e)) => UpdaterView {
                configured: true,
                reachable: false,
                version: None,
                api_version: None,
                problem: Some(format!("the updater is not answering: {e:#}")),
            },
            Err(_) => UpdaterView {
                configured: true,
                reachable: false,
                version: None,
                api_version: None,
                problem: Some("the updater is not answering".into()),
            },
        },
    }
}

/// What moving the control plane to `to` would do to the deployment's files.
pub async fn plan(state: &AppState, to: &Version) -> Result<UpgradePlan> {
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
    let planned = plan(state, to).await?;
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
