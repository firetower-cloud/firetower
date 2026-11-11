//! How a run ends, what it leaves, and when a schedule stops itself.
//!
//! The sweep learns a run ended by **asking**, not by being told.
//! `reclaim.rs`'s argument transfers: finishing is not one event — the agent
//! reports it, or a host says so on reconnect, or somebody removes a machine —
//! and a push hook catches the first, misses the other two, and misses all
//! three if the process restarted in between.
//!
//! Two things here are easy to get wrong and are written down rather than
//! inferred.
//!
//! **"Clean" requires at least one checkout.** `session_work` returns an empty
//! list for a workspace with nothing checked out, so "nothing uncommitted" is
//! *vacuously* true — and `desktop/src/ui/end.ts` already learned this and
//! calls the bare workspace "the dangerous case, not the safe one", because
//! git never saw the directory, so every file the agent made goes with it and
//! there is no branch to promise anybody. A run with no checkout is therefore
//! never clean and is never deleted, whatever the switch says and whether or
//! not the form remembered to hide it.
//!
//! **The timeout stops waiting, not the run.** The only way this process can
//! stop a run is `destroy_as`, which marks the session `Ended` — which puts it
//! in front of `reclaim::sweep`, which deletes the conversation within the
//! minute, question included. So after `needs_you_within` the run is settled
//! with outcome `needs_you`, the question's text is copied into the history,
//! and the agent stays parked in a workspace that is still standing. Somebody
//! can answer it an hour later.
//!
//! The corollary is the property that makes five defensible: **a question
//! answered inside the window never counts at all.** The run goes back to
//! working, finishes, and resets the streak to nought. So the pause is only
//! ever reached by questions nobody was there to answer, which is exactly the
//! condition it exists to detect — somebody who works mornings never trips it.

use crate::AppState;
use chrono::{DateTime, Utc};
use ft_core::schedule::{Outcome, PausedReason};
use ft_core::{ScheduleId, SessionStatus};

/// Everything the sweep still has something to do about.
pub async fn pass(state: &AppState, now: DateTime<Utc>) -> anyhow::Result<()> {
    for run in state.db.live_runs().await? {
        if run.state != "running" {
            continue;
        }
        let Some(session_id) = run.session_id.clone() else {
            continue;
        };
        let Some(session) = state.db.session(&session_id).await? else {
            // The workspace was removed before this run could be read — by a
            // person, or by `reclaim` after somebody ended it. Kept as a line
            // with no claim about what it left, which is the honest answer.
            let settled = state
                .db
                .settle_run(
                    &run.id,
                    "finished",
                    Some("unknown"),
                    Some("Finished. The workspace was removed before this run could be read."),
                    None,
                    None,
                    false,
                )
                .await?;
            if settled {
                after_terminal(state, &run.schedule_id).await?;
            }
            continue;
        };

        let since_launch = now - run.launched_at.unwrap_or(run.claimed_at);
        let max_runtime = chrono::TimeDelta::seconds(run.max_runtime_secs);

        match session.status {
            // Still going. Nothing stops it — the overrun rule watches, it
            // does not act on the run.
            SessionStatus::Starting | SessionStatus::Working => {
                overrun(state, &run, since_launch, max_runtime).await?;
            }

            // It stopped to ask, and nobody is there.
            SessionStatus::NeedsYou => {
                // How long it has been asking. `updated_at` moves on every
                // status change, so answering takes the session back to
                // `Working` and this never fires — which is the property that
                // makes the five-run bound mean "nobody was there".
                let asking_for = now - session.updated_at;
                let window = chrono::TimeDelta::seconds(run.needs_you_secs);

                // **A run started by hand waits.** You pressed it and you are
                // there; only a scheduled run times out.
                if run.source == "manual" || asking_for < window {
                    // And it may still overrun while it waits, which is a
                    // different fact about a different deadline.
                    overrun(state, &run, since_launch, max_runtime).await?;
                    continue;
                }

                // The question, in the agent's own words, copied into the
                // history — because the workspace it lives in may be gone by
                // the time anybody reads the line, and nothing else in the
                // product reads a question's text off a session.
                let question = session
                    .note
                    .as_deref()
                    .map(|q| format!("Waiting. {q}"))
                    .unwrap_or_else(|| "Waiting. It asked a question.".to_string());
                let settled = state
                    .db
                    .settle_run(
                        &run.id,
                        "finished",
                        Some("needs_you"),
                        Some(&question),
                        session.proposed_title.as_deref(),
                        None,
                        // The workspace stands. Ending it is what would delete
                        // the question.
                        true,
                    )
                    .await?;
                if settled {
                    after_terminal(state, &run.schedule_id).await?;
                }
            }

            // Something broke, and it is somebody's move.
            SessionStatus::Failed => {
                let settled = state
                    .db
                    .settle_run(
                        &run.id,
                        "failed",
                        None,
                        Some(&format!(
                            "Failed. {}",
                            session
                                .note
                                .as_deref()
                                .unwrap_or("The run ended without finishing.")
                        )),
                        session.proposed_title.as_deref(),
                        Some(&super::error_code(crate::api::ErrorCode::ActionFailed)),
                        true,
                    )
                    .await?;
                if settled {
                    after_terminal(state, &run.schedule_id).await?;
                }
            }

            // The agent did its turn and is waiting for the next thing, which
            // for an unattended run is the end of the work.
            SessionStatus::HandedBack | SessionStatus::Ready => {
                // One more pass, if `describe()` may still be writing the
                // summary. It takes seconds and may land after the sweep next
                // looks; settling now would keep a line that says nothing.
                let waited = now - session.updated_at;
                if session.proposed_title.is_none() && waited < super::SUMMARY_GRACE {
                    continue;
                }
                finished(state, &run, &session, since_launch, max_runtime).await?;
            }

            // Ended by somebody, so the workspace has gone with it.
            SessionStatus::Ended => {
                let settled = state
                    .db
                    .settle_run(
                        &run.id,
                        "finished",
                        Some("unknown"),
                        Some("Finished. The workspace was ended before this run could be read."),
                        session.proposed_title.as_deref(),
                        None,
                        false,
                    )
                    .await?;
                if settled {
                    after_terminal(state, &run.schedule_id).await?;
                }
            }
        }
    }
    Ok(())
}

/// A run that has been going too long.
///
/// **Observations, not runs.** A run that overruns is still `Working`, so by
/// the overlap rule every following occurrence is skipped — which means a
/// second *run* never starts, so a second *overrun* never arrives, and the
/// schedule would sit stuck behind one runaway agent forever. So a strike at
/// `max_runtime`, a second one `max_runtime` later, then pause.
///
/// Derived from the elapsed time rather than counted in a column: the nth
/// observation is `elapsed / max_runtime`, which needs no writer and cannot
/// drift. The agent is never touched — stopping it would destroy the
/// conversation that explains why it overran, by the same sweep that reports
/// it, which is the mechanism reporting the problem erasing the evidence.
async fn overrun(
    state: &AppState,
    run: &crate::db::LiveRun,
    elapsed: chrono::TimeDelta,
    max_runtime: chrono::TimeDelta,
) -> anyhow::Result<()> {
    if max_runtime <= chrono::TimeDelta::zero() || elapsed < max_runtime {
        return Ok(());
    }
    let observations = (elapsed.num_seconds() / max_runtime.num_seconds()).max(1);
    let hours = elapsed.num_minutes() as f64 / 60.0;

    if observations == 1 {
        // Recorded, so the page can say it. The run keeps running.
        state
            .db
            .set_run_detail(
                &run.id,
                &format!(
                    "Running, {hours:.0}h in — longer than this schedule allows. Nothing stops a \
                     run for taking too long."
                ),
            )
            .await?;
        return Ok(());
    }

    // The second observation. The *schedule* pauses; the run does not.
    //
    // A separate path to paused, sharing only the destination. The streak
    // counts completed runs and this watches one that has not completed, so an
    // overrunning run has no outcome and cannot join a streak — merging them
    // would double-count one incident: a strike for overrunning, then a second
    // when the same run finally ends failed.
    state
        .db
        .set_run_detail(
            &run.id,
            &format!("Running, {hours:.0}h in. The schedule was stopped; this run was not."),
        )
        .await?;
    if state
        .db
        .pause_schedule(&run.schedule_id, super::reason_name(PausedReason::Overran))
        .await?
    {
        quiet_the_clock(state, &run.schedule_id).await?;
        announce(state, &run.schedule_id, "after two runs overran").await;
    }
    Ok(())
}

/// A run whose agent has handed back: what it left, and whether to delete it.
async fn finished(
    state: &AppState,
    run: &crate::db::LiveRun,
    session: &ft_core::Session,
    elapsed: chrono::TimeDelta,
    max_runtime: chrono::TimeDelta,
) -> anyhow::Result<()> {
    // The summary **first**, before anything is torn down. A copy rather than
    // a join: `describe()` writes `proposed_title` seconds after a hand-back
    // and `reclaim.rs` deletes it a minute after the end.
    let summary = session.proposed_title.clone();

    // Classified from a live round trip, which is why "could not tell" is one
    // of the answers rather than an error.
    let outcome = classify(state, session, elapsed, max_runtime).await;

    let (line, kept) = match outcome {
        Outcome::Clean if run.delete_clean_runs => {
            // `destroy_as` with the owner's row, and **never forcing** — see
            // `Removal::the_workspace`. A host that is not answering refuses,
            // the workspace survives, and the failure is reported rather than
            // worked around.
            match delete_workspace(state, run, session).await {
                Ok(()) => (
                    line_for(Outcome::Clean, summary.as_deref(), session),
                    false,
                ),
                Err(why) => (
                    format!(
                        "{} The workspace could not be deleted: {why}",
                        line_for(Outcome::Clean, summary.as_deref(), session)
                    ),
                    true,
                ),
            }
        }
        other => (line_for(other, summary.as_deref(), session), true),
    };

    let settled = state
        .db
        .settle_run(
            &run.id,
            "finished",
            Some(outcome_name(outcome)),
            Some(&line),
            summary.as_deref(),
            None,
            kept,
        )
        .await?;
    if settled {
        after_terminal(state, &run.schedule_id).await?;
    }
    Ok(())
}

/// What a finished run left behind.
///
/// **Unreadable means keep, never delete.** `fleet.summarize` is a live round
/// trip, and `session_work`'s own comment is emphatic that an absent number is
/// "absent, never zero" — filling them with zeros is what previously drew a
/// dead host as a workspace with nothing left to commit.
async fn classify(
    state: &AppState,
    session: &ft_core::Session,
    elapsed: chrono::TimeDelta,
    max_runtime: chrono::TimeDelta,
) -> Outcome {
    // An overrun is not a clean run, however it ended. Derived from the
    // duration rather than remembered, so it agrees with what the overrun
    // observer said while it was still going.
    if max_runtime > chrono::TimeDelta::zero() && elapsed >= max_runtime {
        return Outcome::Overran;
    }

    let summaries = match state.fleet.summarize(&session.host_id, &session.id).await {
        Ok(found) => found,
        // The machine can no longer be asked, so nothing here knows what the
        // run left. Kept, correctly — and the line must not claim it was kept
        // *because* something was uncommitted, which would be a guess stated
        // as a fact.
        Err(_) => return Outcome::Unknown,
    };

    // **The dangerous case, not the safe one.** Nothing checked out means
    // nothing to compare, so this is never clean and is therefore never
    // deleted.
    if summaries.is_empty() {
        return Outcome::Kept;
    }

    let all_clear = summaries.iter().all(|c| {
        c.trouble.is_none() && c.summary.uncommitted == 0 && c.summary.pushed && c.summary.ahead == 0
    });
    match all_clear {
        true => Outcome::Clean,
        false => Outcome::Kept,
    }
}

/// The history line for a finished run.
///
/// The agent's own summary when there is one. A run without one falls back to
/// what git can see rather than showing an empty row — `describe()` gives up
/// when there is no credential, or an account switched, or the agent answered
/// with nothing, and none of those is a failure or should read as one.
fn line_for(outcome: Outcome, summary: Option<&str>, session: &ft_core::Session) -> String {
    if let Some(said) = summary.map(str::trim).filter(|s| !s.is_empty()) {
        return said.to_string();
    }
    // **No repository, so nothing is ever summarised.** `describe()` never
    // runs without a checkout, and the absence is explained once on the page
    // rather than guessed at per row.
    if session.checkouts.is_empty() && session.repo.is_none() {
        return "Finished.".to_string();
    }
    match (outcome, session.branch.as_deref()) {
        (Outcome::Clean, Some(branch)) => format!("Finished. Pushed {branch}."),
        (Outcome::Clean, None) => "Finished. Nothing was left to commit or push.".to_string(),
        (Outcome::Overran, _) => "Finished, after running longer than this schedule allows.".into(),
        (Outcome::Unknown, _) => {
            "Finished. The machine could not be reached, so what it left could not be read.".into()
        }
        (_, Some(branch)) => format!("Finished. Work was left on {branch}."),
        (_, None) => "Finished.".to_string(),
    }
}

fn outcome_name(outcome: Outcome) -> &'static str {
    match outcome {
        Outcome::Clean => "clean",
        Outcome::Kept => "kept",
        Outcome::NeedsYou => "needs_you",
        Outcome::Overran => "overran",
        Outcome::Unknown => "unknown",
    }
}

/// Tear the workspace down, through the one function that does it.
///
/// `destroy_session`'s internals in-process, which is what `destroy_as` is.
/// Not an HTTP call to ourselves, and not a second teardown path.
async fn delete_workspace(
    state: &AppState,
    run: &crate::db::LiveRun,
    session: &ft_core::Session,
) -> Result<(), String> {
    let me = state
        .accounts
        .user_by_id(&ft_core::UserId::from_stored(run.owner_id.clone()))
        .await
        .ok()
        .flatten()
        .ok_or_else(|| "the account this schedule runs as no longer exists".to_string())?;

    state
        .db
        .run_workspace_gone(&run.id)
        .await
        .map_err(|e| e.to_string())?;

    crate::api::sessions::destroy_as(
        state.clone(),
        &me,
        session.id.clone(),
        crate::api::sessions::Removal::the_workspace(),
    )
    .await
    .map(|_| ())
    .map_err(|e| e.message)
}

/// Recompute the streak and pause if a bound is met.
///
/// **After every run that reaches a terminal state**, which is every caller in
/// this module and the two in the sweep. One indexed read of
/// `schedule_runs_history`, scheduled runs only.
pub async fn after_terminal(state: &AppState, schedule: &ScheduleId) -> anyhow::Result<()> {
    let rows = state
        .db
        .runs_for_streak(schedule, super::pause::WINDOW)
        .await?;
    let counted: Vec<super::pause::Counted<'_>> = rows.iter().map(as_counted).collect();
    let streak = super::pause::streak(&counted);
    let Some(reason) = super::pause::bound_met(&streak) else {
        return Ok(());
    };

    // Compare-and-set: zero rows means it was already off, and a schedule a
    // person paused is not re-paused by a rule.
    if !state
        .db
        .pause_schedule(schedule, super::reason_name(reason))
        .await?
    {
        return Ok(());
    }

    quiet_the_clock(state, schedule).await?;

    // The words, for the one place that is not a page: a notification has no
    // history beside it to count. The page derives its own sentence from the
    // runs it is already drawing, which is why nothing of this is stored.
    let said = match (reason, streak.failures, streak.questions) {
        (PausedReason::ThreeFailures, _, _) => "after three runs failed".to_string(),
        (PausedReason::FiveRuns, 0, _) => "after five runs needed you".to_string(),
        (PausedReason::FiveRuns, _, 0) => "after five runs could not finish".to_string(),
        (PausedReason::FiveRuns, f, q) => format!(
            "after five runs in a row did not finish — {f} failed and {q} stopped to ask"
        ),
        (other, _, _) => format!("because {}", super::reason_name(other)),
    };
    announce(state, schedule, &said).await;
    Ok(())
}

/// Take a paused schedule's triggers out of the due index.
///
/// `next_fire_at = null` rather than a filter at read time, so the partial
/// index stays the size of the active set rather than of the library. Turning
/// the schedule back on recomputes it.
async fn quiet_the_clock(state: &AppState, schedule: &ScheduleId) -> anyhow::Result<()> {
    for trigger in state.db.triggers_of(schedule).await? {
        state.db.set_next_fire_at(&trigger.id, None).await?;
    }
    Ok(())
}

/// Say it once, when a schedule stops itself.
///
/// Once per pause rather than per refused run: escalating a loud problem into
/// a silent one is the failure mode, and a schedule refused every morning for
/// a month is noise nobody reads.
async fn announce(state: &AppState, schedule: &ScheduleId, why: &str) {
    let name = state
        .db
        .schedule(schedule)
        .await
        .ok()
        .flatten()
        .map(|s| s.name)
        .unwrap_or_else(|| "A schedule".to_string());
    crate::notify::Notifier::from_env().say(
        "Firetower stopped a schedule",
        &format!("{name} will not run again until you turn it on — {why}."),
        super::schedule_url(state, schedule),
    );
}

/// One stored row, as the rule reads it.
pub fn as_counted(row: &crate::db::RunRow) -> super::pause::Counted<'_> {
    super::pause::Counted {
        state: match row.state.as_str() {
            "claimed" => ft_core::schedule::ScheduleRunState::Claimed,
            "running" => ft_core::schedule::ScheduleRunState::Running,
            "finished" => ft_core::schedule::ScheduleRunState::Finished,
            "skipped" => ft_core::schedule::ScheduleRunState::Skipped,
            "refused" => ft_core::schedule::ScheduleRunState::Refused,
            "failed" => ft_core::schedule::ScheduleRunState::Failed,
            "missed" => ft_core::schedule::ScheduleRunState::Missed,
            // A state a later build wrote. Transparent is the only safe
            // reading: it can neither pause a schedule nor absolve one.
            _ => ft_core::schedule::ScheduleRunState::Lost,
        },
        outcome: match row.outcome.as_deref() {
            Some("clean") => Some(Outcome::Clean),
            Some("kept") => Some(Outcome::Kept),
            Some("needs_you") => Some(Outcome::NeedsYou),
            Some("overran") => Some(Outcome::Overran),
            Some("unknown") => Some(Outcome::Unknown),
            _ => None,
        },
        error_code: row.error_code.as_deref(),
    }
}
