//! From a claimed occurrence to a running agent.
//!
//! Due trigger → claimed `schedule_runs` row → **re-authorization** →
//! `create_session_as`, of which Schedules becomes the third caller, beside
//! `delegate::spawn` rather than inside it. What is genuinely shared is one
//! level down: `delegate::serve`'s twelve tools all start by loading the
//! session that asked, and a timer has no session, so `authoring_session`, the
//! flat no-grandchildren rule and the Manager check are all meaningless to it.
//!
//! ## Why the gate cannot live inside `create_session_as`
//!
//! That function takes an owner and makes every check against it, which is
//! correct and is why `delegate::spawn` can use it. But it is not an
//! authorization boundary: the disabled-user check lives in `accounts.rs`, on
//! the sign-in path, and `set_disabled` deletes `user_sessions` and nothing
//! else. A disabled person's browser is signed out; their schedules would keep
//! firing forever, and nothing in the launch path would notice.
//!
//! So a schedule is a durable authorization, and nothing is trusted from the
//! row except *what was approved*. Every permission is read fresh,
//! immediately before the vault is touched.

use crate::api::sessions::{create_session_as, Launch};
use crate::api::ErrorCode;
use crate::AppState;
use ft_core::{RepoId, ScheduleId, ScheduleRunId, SessionId, UserId};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock};
use tokio::sync::RwLock;

/// Runs this process is launching right now.
///
/// So the orphan reconciler does not adopt a launch that is merely slow: one
/// taking ninety seconds is not an orphan, and the five-minute fence is only
/// the guard for a claim that outlived the process that took it.
fn launching() -> &'static Arc<RwLock<HashSet<String>>> {
    static HELD: OnceLock<Arc<RwLock<HashSet<String>>>> = OnceLock::new();
    HELD.get_or_init(Default::default)
}

/// The run ids currently being launched here.
pub async fn in_flight() -> HashSet<String> {
    launching().read().await.clone()
}

/// Start a claimed occurrence, off the sweep.
///
/// `tokio::spawn` per occurrence, which is the shape `delegate::serve` already
/// argued for: "starting a workspace waits on a host, and a second lead asking
/// meanwhile should not queue behind the first". Twenty due schedules in one
/// pass want the same treatment.
pub fn spawn(
    state: AppState,
    schedule: crate::db::ScheduleRow,
    run: ScheduleRunId,
    on_host: Option<&mut HashMap<String, usize>>,
    per_host: usize,
) {
    // The per-host cap, for a schedule that pinned a machine.
    //
    // **Only for a pinned one, and that is a known gap.** The floor is a
    // coarse guard rather than an accountant: one pass may admit several
    // launches against one disk reading. Where a machine is named the pass can
    // bound it here, before anything is started. Where none is named the
    // machine is chosen inside `create_session_as`, which does not tell its
    // caller which it picked — so an unpinned pass is bounded by `AT_ONCE`
    // alone. Bounding that properly means the launch path reporting its choice
    // back, which is a change to its contract rather than to this file.
    if let (Some(seen), Some(pinned)) = (on_host, pinned_host(&schedule.spec)) {
        let count = seen.entry(pinned.clone()).or_default();
        if *count >= per_host {
            let state = state.clone();
            let id = schedule.id.clone();
            tokio::spawn(async move {
                let _ = state
                    .db
                    .settle_run(
                        &run,
                        "skipped",
                        None,
                        Some("Skipped. Too many runs were starting on that machine at once."),
                        None,
                        None,
                        false,
                    )
                    .await;
                let _ = super::settle::after_terminal(&state, &id).await;
            });
            return;
        }
        *count += 1;
    }

    tokio::spawn(async move {
        launching().write().await.insert(run.as_str().to_string());
        if let Err(e) = start(&state, &schedule, &run).await {
            tracing::warn!(run = %run, "starting a scheduled run: {e:#}");
        }
        launching().write().await.remove(run.as_str());
    });
}

/// Which machine a schedule named, if it named one.
fn pinned_host(spec: &serde_json::Value) -> Option<String> {
    spec.get("hostId")?.as_str().map(str::to_string)
}

/// Why a launch did not happen.
struct Stopped {
    /// `refused` — nothing was started and nothing is broken — or `failed`.
    state: &'static str,
    detail: String,
    code: ErrorCode,
    /// Whether the schedule itself should stop. Only gate 1 sets this: a
    /// disabled owner is not a streak, it is a stop.
    and_stop: Option<ft_core::schedule::PausedReason>,
}

/// Re-authorize, then launch.
///
/// The gates are in this order and the vault is last. A failure on any of them
/// is recorded and the run ends there — before any credential is read.
///
/// `pub(crate)` for the tests rather than for any caller: [`spawn`] is how the
/// sweep reaches this, and a test awaiting the spawned task would be racing it
/// rather than asserting on it.
pub(crate) async fn start(
    state: &AppState,
    schedule: &crate::db::ScheduleRow,
    run: &ScheduleRunId,
) -> anyhow::Result<()> {
    match gate(state, schedule).await {
        Err(stopped) => {
            let settled = state
                .db
                .settle_run(
                    run,
                    stopped.state,
                    None,
                    Some(&format!("Refused. {}", stopped.detail)),
                    None,
                    Some(&super::error_code(stopped.code)),
                    false,
                )
                .await?;
            if let Some(reason) = stopped.and_stop {
                // Not a streak — a stop. And it pauses so that re-enabling the
                // person does not silently re-arm six months of automation.
                state
                    .db
                    .pause_schedule(&schedule.id, super::reason_name(reason))
                    .await?;
            } else if settled {
                super::settle::after_terminal(state, &schedule.id).await?;
            }
            Ok(())
        }
        Ok(spec) => {
            // **Minted here, not inside.** Written onto the run before the
            // launch is attempted, so a crash mid-launch leaves a claim that
            // can be reconciled instead of an orphan nothing can ask about.
            let session = SessionId::new();
            state.db.set_run_session(run, &session).await?;

            let launched = create_session_as(
                state.clone(),
                schedule.owner_id.clone(),
                whose(state, &schedule.owner_id).await,
                spec,
                Launch {
                    lineage: None,
                    id: Some(session.clone()),
                    // **Nothing is inherited.** `carry_preferences` fills an
                    // unset control from whatever this person was last
                    // working with, so a schedule approved with an unset
                    // sandbox would start on a choice made in an unrelated
                    // session afterwards — for Codex, that includes no
                    // filesystem fence at all. An unset field falls to the
                    // agent's own default instead, which is fixed.
                    inherit_settings: false,
                },
            )
            .await;

            match launched {
                Ok(started) => {
                    let host = state
                        .db
                        .host_by_id(&started.host_id)
                        .await?
                        .map(|h| h.name)
                        .unwrap_or_default();
                    state.db.run_launched(run, &started.id, &host).await?;
                    Ok(())
                }
                Err(e) => {
                    // The whole of the mapping. `HostUnreachable` is a
                    // failure that says nothing about the schedule, so it
                    // joins the streak without counting toward the three;
                    // `NoCapacity` is a refusal, because nothing was started
                    // and nothing is broken.
                    let refusal = matches!(e.code, ErrorCode::NoCapacity);
                    let word = match refusal {
                        true => "refused",
                        false => "failed",
                    };
                    let settled = state
                        .db
                        .settle_run(
                            run,
                            word,
                            None,
                            Some(&format!(
                                "{}. {}",
                                match refusal {
                                    true => "Refused",
                                    false => "Failed",
                                },
                                e.message
                            )),
                            None,
                            Some(&super::error_code(e.code)),
                            false,
                        )
                        .await?;
                    if settled {
                        super::settle::after_terminal(state, &schedule.id).await?;
                    }
                    Ok(())
                }
            }
        }
    }
}

/// Every permission, read fresh.
async fn gate(
    state: &AppState,
    schedule: &crate::db::ScheduleRow,
) -> Result<ft_core::NewSession, Stopped> {
    // 1 · The person still exists and is enabled.
    let owner = state
        .accounts
        .user_by_id(&UserId::from_stored(schedule.owner_id.clone()))
        .await
        .ok()
        .flatten();
    match owner {
        None => {
            return Err(Stopped {
                state: "refused",
                detail: "The account this schedule runs as no longer exists.".into(),
                code: ErrorCode::Forbidden,
                and_stop: Some(ft_core::schedule::PausedReason::OwnerDisabled),
            })
        }
        Some(who) if who.disabled => {
            return Err(Stopped {
                state: "refused",
                detail: "The account this schedule runs as is disabled.".into(),
                code: ErrorCode::Forbidden,
                and_stop: Some(ft_core::schedule::PausedReason::OwnerDisabled),
            })
        }
        Some(_) => {}
    }

    // 2 · Every repository is theirs. Not `Db::repo` — the predicate, every
    // launch, however long ago the schedule was approved.
    for repo in repos_in(&schedule.spec) {
        let theirs = state
            .db
            .repo_of(&schedule.owner_id, &RepoId::from_stored(repo.clone()))
            .await
            .ok()
            .flatten();
        let Some(theirs) = theirs else {
            return Err(Stopped {
                state: "failed",
                detail: "A repository this schedule checks out is no longer connected.".into(),
                code: ErrorCode::RepoNotConnected,
                and_stop: None,
            });
        };

        // **And the owner still has authority over the remote, not just over
        // the row.**
        //
        // Owning the local `repos` row says somebody connected it once. It
        // says nothing about whether their authorization on the git host is
        // still good — and `credential_for` answers `None` for "we hold
        // nothing for this person on this host", which the launch path treats
        // as "work off whatever credentials the worker already has". That is
        // deliberate and right for an interactive session: a local path, or a
        // host nobody authorized, on a machine whose ssh key opens it.
        //
        // For an unattended run it is the wrong default twice over. Disconnect
        // the owner's provider and the schedule keeps reaching private code —
        // under the *worker's* identity, which is shared by every session on
        // that machine, after the owner's own authorization is gone. Nothing
        // would say so, because falling back is not an error.
        //
        // So this path fails closed: a remote on a git host needs a
        // credential of the owner's, now. A local path needs none and asks
        // for none — `host_of` is what tells them apart, and it is the same
        // function the credential lookup uses to decide which host a remote
        // is on.
        if crate::providers::host_of(&theirs.remote).is_some()
            && crate::api::credential_for_repo(
                state,
                &theirs,
                &schedule.owner_id,
                &format!("checking authorization for {}", theirs.slug),
            )
            .await
            .is_none()
        {
            return Err(Stopped {
                state: "failed",
                detail: format!(
                    "Firetower holds no git authorization for {} any more, and an unattended run \
                     is not given the machine's own. Reconnect the git host on the Repositories \
                     screen.",
                    theirs.slug
                ),
                code: ErrorCode::RepoAccessDenied,
                and_stop: None,
            });
        }
    }

    // 3 · The machine is theirs, at Writer.
    //
    // Left to `create_session_as`, which narrows candidates to
    // `hosts_for(owner, Writer)` and cannot be reached around — a machine
    // somebody was not given is "no host is available" there rather than a
    // refusal that confirms it exists. Asserting it again here would be a
    // second copy of one predicate, free to disagree with the first.

    // 4 · The subscription is spendable.
    //
    // **A missing pin is a refusal, not a skip.** These checks used to sit
    // behind "is there an account pinned", so a schedule approved while none
    // was connected skipped both of them — and `pin_agent_account`, a
    // `before insert` trigger, then selected whatever default had turned up
    // since. The schedule spent an account nothing had authorized, against a
    // limit nothing had read; and with no portable credential the launch
    // falls through to host-local authentication, which is the worker's
    // identity rather than the owner's.
    //
    // `accountNeeded` tells an approved credential-free engine — a plain
    // shell has nothing to authenticate — from a pin that is simply absent.
    // Absent is the state this refuses.
    let account = schedule
        .pins
        .get("accountId")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let needs_account = schedule
        .pins
        .get("accountNeeded")
        .and_then(|v| v.as_bool())
        // A schedule approved before this was recorded. Fail closed: the
        // engines that need none are the ones nothing offers.
        .unwrap_or(true);
    if needs_account && account.is_none() {
        return Err(Stopped {
            state: "failed",
            detail: "This schedule does not say which subscription it spends, so it will not be \
                     left to pick one. Edit it to choose, and approve it again."
                .into(),
            code: ErrorCode::InvalidRequest,
            and_stop: None,
        });
    }
    if let Some(account) = &account {
        match state
            .db
            .account_spendable(&schedule.owner_id, account)
            .await
            .ok()
            .flatten()
        {
            None => {
                return Err(Stopped {
                    state: "failed",
                    detail: "The subscription this schedule was approved to spend is gone.".into(),
                    code: ErrorCode::InvalidRequest,
                    and_stop: None,
                })
            }
            Some((name, false)) => {
                return Err(Stopped {
                    state: "failed",
                    detail: format!("The {name} subscription is not connected."),
                    code: ErrorCode::InvalidRequest,
                    and_stop: None,
                })
            }
            Some((_, true)) => {}
        }

        // 5 · It is not at its usage limit. **Refused, not failed**, and no
        // strike: nothing was started and nothing was spent.
        if state
            .db
            .account_at_its_limit(account)
            .await
            .unwrap_or(false)
        {
            let name = state
                .db
                .account_spendable(&schedule.owner_id, account)
                .await
                .ok()
                .flatten()
                .map(|(n, _)| n)
                .unwrap_or_else(|| "that".into());
            return Err(Stopped {
                state: "refused",
                detail: format!("The {name} subscription was at its limit."),
                code: ErrorCode::NoCapacity,
                and_stop: None,
            });
        }
    }

    // 6 · The pins still resolve. Fail closed — never substitute a default,
    // which is the substitution pinning exists to prevent.
    let versions: Vec<String> = schedule
        .pins
        .get("skillVersionIds")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    if !state
        .db
        .skill_versions_resolve(&versions)
        .await
        .unwrap_or(false)
    {
        return Err(Stopped {
            state: "failed",
            detail: "A skill version this schedule pinned is no longer there.".into(),
            code: ErrorCode::InvalidRequest,
            and_stop: None,
        });
    }

    // 7 · Only now: the vault, inside `create_session_as`. Every secret is
    // resolved fresh at its current value, which is the point — a rotated
    // secret takes effect without re-approval.
    spec_of(schedule).map_err(|detail| Stopped {
        state: "failed",
        detail,
        code: ErrorCode::InvalidRequest,
        and_stop: None,
    })
}

/// The approved spec, with everything the schedule pinned put back explicitly.
///
/// **`settings: {}` is not "the defaults".** `carry_preferences` fills any
/// unset control field from whatever that person was last working with, so an
/// absent field means "whatever they were doing at 5pm yesterday" — which
/// would change what the 9am unattended run does. All four are written in
/// explicitly or the pinning is a fiction.
pub fn spec_of(schedule: &crate::db::ScheduleRow) -> Result<ft_core::NewSession, String> {
    let mut spec = schedule.spec.clone();
    let obj = spec
        .as_object_mut()
        .ok_or_else(|| "this schedule's approved settings cannot be read".to_string())?;

    for field in ["settings", "skills", "accountId", "profile"] {
        if let Some(pinned) = schedule.pins.get(field) {
            obj.insert(field.to_string(), pinned.clone());
        }
    }

    // Neither is a control, and both are pinned rather than defaulted —
    // `Equal` is what a workspace takes when nobody says, and an unattended
    // run should yield to whoever is at their desk. From the values rather
    // than from their names, so a rename cannot leave this writing a word
    // nothing reads back.
    obj.insert(
        "size".into(),
        serde_json::to_value(ft_core::WorkspaceSize::Medium).unwrap_or_default(),
    );
    obj.insert(
        "share".into(),
        serde_json::to_value(ft_core::Share::Yields).unwrap_or_default(),
    );
    // **Never reused.** Each run starts a new workspace, so naming one here
    // would be the one thing this feature does not do.
    obj.remove("workspaceId");

    serde_json::from_value(spec).map_err(|e| format!("this schedule cannot be started: {e}"))
}

/// Which repositories a spec checks out.
fn repos_in(spec: &serde_json::Value) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(one) = spec.get("repoId").and_then(|v| v.as_str()) {
        out.push(one.to_string());
    }
    if let Some(list) = spec.get("repos").and_then(|v| v.as_array()) {
        for asked in list {
            if let Some(id) = asked.get("repoId").and_then(|v| v.as_str()) {
                if !out.iter().any(|seen| seen == id) {
                    out.push(id.to_string());
                }
            }
        }
    }
    out
}

/// The owner in words, for the vault's log.
async fn whose(state: &AppState, owner: &str) -> String {
    state
        .accounts
        .user_by_id(&UserId::from_stored(owner.to_string()))
        .await
        .ok()
        .flatten()
        .map(|u| u.username)
        .unwrap_or_else(|| owner.to_string())
}

/// Start one now, by hand.
///
/// **Marked `manual`, and the clock is not moved.** The pause rule reads only
/// scheduled runs: you pressed this and you are there, so three manual presses
/// that each asked something must not pause a schedule that has never failed
/// on its own clock.
///
/// It also never times out waiting for an answer, for the same reason — see
/// `settle::pass`.
pub async fn run_now(
    state: &AppState,
    schedule: &crate::db::ScheduleRow,
) -> anyhow::Result<ScheduleRunId> {
    let id = ScheduleRunId::new();
    // `fire_at` is now rather than an occurrence, so it cannot collide with a
    // scheduled one — and the unique index still holds, because two presses in
    // the same microsecond are not a thing a person does.
    let claimed = state
        .db
        .claim_run(
            &id,
            &schedule.id,
            None,
            chrono::Utc::now(),
            schedule.revision,
            "manual",
            "claimed",
            None,
        )
        .await?
        .ok_or_else(|| anyhow::anyhow!("a run is already claimed for this moment"))?;

    spawn(state.clone(), schedule.clone(), claimed.clone(), None, 0);
    Ok(claimed)
}

/// Whether a schedule has a run in flight, for a page that has to offer Stop
/// the run rather than Run now.
pub async fn live_run_of(
    state: &AppState,
    schedule: &ScheduleId,
) -> anyhow::Result<Option<SessionId>> {
    for run in state.db.live_runs().await? {
        if &run.schedule_id == schedule {
            if let Some(session) = run.session_id {
                return Ok(Some(session));
            }
        }
    }
    Ok(None)
}
