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
                    // **And while it waits, it does not say "Running."** The
                    // run is still live and must not settle — a question
                    // answered inside the window never counts at all, which
                    // is the property the whole pause rule rests on — but the
                    // agent is not working, it is asking, and for up to
                    // `needs_you_within` the row claimed otherwise. The one
                    // person who can end that wait was being told there was
                    // nothing to do.
                    let asking = session
                        .note
                        .as_deref()
                        .map(|q| format!("Waiting for an answer. {q}"))
                        .unwrap_or_else(|| "Waiting for an answer.".to_string());
                    if run.detail.as_deref() != Some(asking.as_str()) {
                        state.db.set_run_detail(&run.id, &asking).await?;
                    }
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
            //
            // **Settled now, not after the grace.** This waited up to
            // `SUMMARY_GRACE` for `describe()` to write a summary — so a run
            // that had plainly finished was recorded as *running* for up to a
            // sweep plus two minutes, and the row said "Running." about an
            // agent anybody could open and see had stopped. The waiting was
            // right and the label was a lie.
            //
            // The outcome does not depend on the summary: `classify` asks git
            // and the clock, and `describe()` only supplies the words. So the
            // state goes down immediately with the outcome and the timing,
            // and [`owed`] fills the words in when they land. See
            // `Db::runs_awaiting_their_end`.
            SessionStatus::HandedBack | SessionStatus::Ready => {
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

/// What a finished run still owes: the agent's own words, and a teardown.
///
/// **The second half of settling promptly.** `pass` records the state the
/// moment a session hands back, because claiming an agent is still running
/// when it has stopped is telling somebody something untrue about their own
/// work. Two things genuinely cannot be known yet at that moment, and this is
/// where they land:
///
/// - **The summary.** `describe()` writes `proposed_title` seconds after the
///   hand-back. The line settles with what git can see — which is a real
///   sentence, not a blank — and is rewritten in the agent's own words when
///   they arrive.
/// - **The teardown.** Deleting a clean run's workspace takes the session
///   with it, so doing it before the summary lands would lose the words for
///   good. It happens here instead, once they have arrived or the grace has
///   run out.
///
/// Past the grace nothing more is owed: the line keeps what git said, and a
/// clean run is deleted on that last look. The query is bounded by `ended_at`
/// so a control plane that restarted still finishes what the one before it
/// started, rather than scanning the whole history to find out.
pub async fn owed(state: &AppState, now: DateTime<Utc>) -> anyhow::Result<()> {
    // Wide enough to cover a restart, narrow enough to be the recent tail.
    let since = now - super::SUMMARY_GRACE * 10;
    for run in state.db.runs_awaiting_their_end(since).await? {
        let Some(session_id) = run.session_id.clone() else {
            continue;
        };
        let Some(session) = state.db.session(&session_id).await? else {
            // The workspace has gone — somebody ended it, or `reclaim` did.
            // Nothing is owed and nothing can be read: the line stays as it
            // was settled, which is the honest answer, and the row stops
            // claiming to hold a workspace.
            state.db.run_workspace_gone(&run.id).await?;
            continue;
        };

        let outcome = match run.outcome.as_deref() {
            Some("clean") => Outcome::Clean,
            Some("kept") => Outcome::Kept,
            Some("needs_you") => Outcome::NeedsYou,
            Some("overran") => Outcome::Overran,
            _ => Outcome::Unknown,
        };

        // The words, if they have arrived. Written once — `set_run_summary`
        // will not overwrite one — so two control planes both seeing this
        // land write the same thing once.
        if let Some(words) = session.proposed_title.as_deref() {
            state
                .db
                .set_run_summary(
                    &run.id,
                    words,
                    &line_for(outcome, Some(words), &session, None),
                )
                .await?;
        }

        // And the teardown, once there is nothing left to wait for.
        let waited = now - run.ended_at.unwrap_or(run.claimed_at);
        let still_coming = session.proposed_title.is_none() && waited < super::SUMMARY_GRACE;
        if still_coming || outcome != Outcome::Clean || !run.delete_clean_runs {
            continue;
        }

        // **The world is re-read before anything is destroyed, because the
        // deferral is a window and a window is a thing somebody can walk
        // into.**
        //
        // The run settled clean and the teardown waits for the agent's own
        // summary. In that minute the owner can open the workspace and start
        // working in it — and a teardown decided before that would destroy
        // work that did not exist when it was decided. `destroy_as` ends in
        // `git worktree remove --force`, so there is nothing to recover.
        //
        // Not re-reading the *outcome*, which is what was recorded a minute
        // ago and is the thing that cannot be trusted here. Re-reading the
        // state: who has the workspace now, and what is in it now.
        match session.status {
            // Where the run left it. Nobody has picked it up.
            SessionStatus::HandedBack | SessionStatus::Ready => {}
            // Somebody is using it. **Abandoned rather than deferred again**,
            // because retrying next sweep would make this a question of
            // whether they happened to be mid-turn when the sweep ran.
            SessionStatus::Working | SessionStatus::Starting | SessionStatus::NeedsYou => {
                state
                    .db
                    .abandon_teardown(
                        &run.id,
                        &format!(
                            "{} The workspace was kept: it was opened again before this run's \
                             was deleted.",
                            line_for(outcome, session.proposed_title.as_deref(), &session, None)
                        ),
                    )
                    .await?;
                continue;
            }
            // Already gone, or broken after the fact. Nothing to delete and
            // nothing to say that the line does not say already.
            SessionStatus::Ended | SessionStatus::Failed => {
                state
                    .db
                    .abandon_teardown(
                        &run.id,
                        &line_for(outcome, session.proposed_title.as_deref(), &session, None),
                    )
                    .await?;
                continue;
            }
        }

        // **And clean *now*, asked of git rather than of the row.** A
        // workspace that was resumed, written in and handed back again is
        // clean by its own outcome and is not clean on disk.
        let elapsed = run.ended_at.unwrap_or(now) - run.launched_at.unwrap_or(run.claimed_at);
        let (still, _) = classify(
            state,
            &session,
            elapsed,
            chrono::TimeDelta::seconds(run.max_runtime_secs),
        )
        .await;
        if still != Outcome::Clean {
            state
                .db
                .abandon_teardown(
                    &run.id,
                    &format!(
                        "{} The workspace was kept: there is work in it that was not there when \
                         the run ended.",
                        line_for(outcome, session.proposed_title.as_deref(), &session, None)
                    ),
                )
                .await?;
            continue;
        }

        if let Err(why) = delete_workspace(state, &run, &session).await {
            // Said on the row rather than only in the log, for the reason the
            // settle path says it: a workspace that should have gone and has
            // not is a fact about somebody's disk.
            let line = format!(
                "{} The workspace could not be deleted: {why}",
                line_for(outcome, session.proposed_title.as_deref(), &session, None)
            );
            state.db.set_run_detail(&run.id, &line).await?;
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
    // of the answers rather than an error — and what it saw comes back with
    // it, because that is the only thing that can support a sentence about
    // what the run left.
    let (outcome, seen) = classify(state, session, elapsed, max_runtime).await;

    // **The teardown waits for the words; the record does not.**
    //
    // A clean run's workspace is deleted, and deleting it takes the session
    // with it — so doing that before `describe()` has written its summary
    // loses the agent's own account of what it did, permanently. That is what
    // the grace was buying. It still buys it: with no summary yet, this
    // settles with the workspace standing and [`owed`] deletes it once the
    // words arrive or the grace runs out.
    let (line, kept) = match (outcome, summary.is_some()) {
        (Outcome::Clean, false) if run.delete_clean_runs => (
            line_for(Outcome::Clean, None, session, seen.as_deref()),
            true,
        ),
        (Outcome::Clean, true) if run.delete_clean_runs => {
            // `destroy_as` with the owner's row, and **never forcing** — see
            // `Removal::the_workspace`. A host that is not answering refuses,
            // the workspace survives, and the failure is reported rather than
            // worked around.
            match delete_workspace(state, run, session).await {
                Ok(()) => (
                    line_for(Outcome::Clean, summary.as_deref(), session, seen.as_deref()),
                    false,
                ),
                Err(why) => (
                    format!(
                        "{} The workspace could not be deleted: {why}",
                        line_for(Outcome::Clean, summary.as_deref(), session, seen.as_deref())
                    ),
                    true,
                ),
            }
        }
        (other, _) => (
            line_for(other, summary.as_deref(), session, seen.as_deref()),
            true,
        ),
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
/// **And what it saw, not only what it concluded.** The line used to be
/// composed from the outcome and a branch name, which is how a run that
/// pushed nothing came to say "Pushed agent/test3-3." — `Clean` is equally
/// true of an agent that changed nothing, and a branch name exists either
/// way. The numbers that decided the outcome are the only thing that can
/// support a sentence about it, so they come back with it.
///
/// `None` for "the machine could not be asked", which is `Unknown` and is a
/// different thing from asking and finding nothing.
async fn classify(
    state: &AppState,
    session: &ft_core::Session,
    elapsed: chrono::TimeDelta,
    max_runtime: chrono::TimeDelta,
) -> (Outcome, Option<Vec<ft_core::CheckoutSummary>>) {
    // An overrun is not a clean run, however it ended. Derived from the
    // duration rather than remembered, so it agrees with what the overrun
    // observer said while it was still going.
    if max_runtime > chrono::TimeDelta::zero() && elapsed >= max_runtime {
        return (Outcome::Overran, None);
    }

    let summaries = match state.fleet.summarize(&session.host_id, &session.id).await {
        Ok(found) => found,
        // The machine can no longer be asked, so nothing here knows what the
        // run left. Kept, correctly — and the line must not claim it was kept
        // *because* something was uncommitted, which would be a guess stated
        // as a fact.
        Err(_) => return (Outcome::Unknown, None),
    };

    // **The dangerous case, not the safe one.** Nothing checked out means
    // nothing to compare, so this is never clean and is therefore never
    // deleted.
    if summaries.is_empty() {
        return (Outcome::Kept, Some(summaries));
    }

    let all_clear = summaries.iter().all(|c| {
        c.trouble.is_none()
            && c.summary.uncommitted == 0
            && c.summary.pushed
            && c.summary.ahead == 0
    });
    let outcome = match all_clear {
        true => Outcome::Clean,
        false => Outcome::Kept,
    };
    (outcome, Some(summaries))
}

/// `n thing` or `n things`, for a sentence that counts.
fn plural(n: u32, thing: &str) -> String {
    match n {
        1 => format!("1 {thing}"),
        n => format!("{n} {thing}s"),
    }
}

/// What one checkout shows, as a clause — or nothing, where it shows nothing.
///
/// **Every clause is supported by a number the worker reported.** The old
/// line asserted a push from the presence of a branch name; these say only
/// what the counts say, and where a count is absent they leave it out rather
/// than guess. `None` means this checkout has nothing to report, which is a
/// real and common answer: Firetower cut the branch and the agent changed
/// nothing.
fn clause(c: &ft_core::CheckoutSummary) -> Option<String> {
    let branch = &c.summary.branch;
    // Unreadable comes first: nothing below it can be trusted about a
    // checkout the worker could not inspect.
    if let Some(trouble) = c
        .trouble
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        return Some(format!("could not read {}: {trouble}", c.slug));
    }
    let kept = match (c.summary.uncommitted, c.summary.ahead) {
        (0, 0) => None,
        (0, ahead) => Some(format!(
            "left {} unpushed on {branch}",
            plural(ahead, "commit")
        )),
        (files, 0) => Some(format!(
            "left {} uncommitted on {branch}",
            plural(files, "file")
        )),
        (files, ahead) => Some(format!(
            "left {} uncommitted and {} unpushed on {branch}",
            plural(files, "file"),
            plural(ahead, "commit")
        )),
    };
    if kept.is_some() {
        return kept;
    }
    // Nothing outstanding. **Whether anything was pushed is a different
    // question**, and `commits` is the only field that answers it: `ahead`
    // starts measuring against the upstream the moment a branch exists on the
    // remote, so a pushed branch holding nothing also reports `ahead: 0`.
    // Absent — from a worker too old to answer — is not zero, and says
    // nothing rather than claiming either way.
    match c.summary.commits {
        Some(n) if n > 0 && c.summary.pushed => {
            Some(format!("pushed {} to {branch}", plural(n, "commit")))
        }
        Some(n) if n > 0 => Some(format!("made {} on {branch}", plural(n, "commit"))),
        _ => None,
    }
}

/// The history line for a finished run.
///
/// The agent's own summary when there is one. A run without one falls back to
/// what git can see rather than showing an empty row — `describe()` gives up
/// when there is no credential, or an account switched, or the agent answered
/// with nothing, and none of those is a failure or should read as one.
fn line_for(
    outcome: Outcome,
    summary: Option<&str>,
    session: &ft_core::Session,
    // What the machine said about each checkout, where it was asked. `None`
    // is "not in hand" — a line being composed a second time, after the
    // run was settled — and is not the same as `Some(&[])`, which is a
    // workspace with nothing checked out.
    seen: Option<&[ft_core::CheckoutSummary]>,
) -> String {
    if let Some(said) = summary.map(str::trim).filter(|s| !s.is_empty()) {
        return said.to_string();
    }
    // **No repository, so nothing is ever summarised.** `describe()` never
    // runs without a checkout, and the absence is explained once on the page
    // rather than guessed at per row.
    if session.checkouts.is_empty() && session.repo.is_none() {
        return "Finished.".to_string();
    }
    // Neither of these depends on a checkout: one is about the clock and the
    // other is about not having been able to look.
    match outcome {
        Outcome::Overran => {
            return "Finished, after running longer than this schedule allows.".to_string()
        }
        Outcome::Unknown => {
            return "Finished. The machine could not be reached, so what it left could not be read."
                .to_string()
        }
        _ => {}
    }

    let Some(seen) = seen else {
        // **The facts are not in hand, so the sentence says only what the
        // outcome itself supports.** `Clean` is defined as nothing
        // uncommitted and nothing unpushed, so that much is safe to say;
        // *why* a run was kept is not, and guessing it is how "Pushed
        // agent/test3-3." came to be printed about a run that pushed nothing.
        return match outcome {
            Outcome::Clean => "Finished. Nothing was left to commit or push.".to_string(),
            _ => "Finished. The workspace was kept.".to_string(),
        };
    };

    says(seen)
}

/// What a finished run left, from what the machine reported.
///
/// **Every checkout speaks.** A run can carry several repositories now, so
/// the first branch does not get to describe the rest: each one with
/// something to report contributes a clause, in the order they are checked
/// out, and a run where none of them has anything to report says so.
///
/// Its own function so it can be read back in a test without a `Session`.
fn says(seen: &[ft_core::CheckoutSummary]) -> String {
    let clauses: Vec<String> = seen.iter().filter_map(clause).collect();
    if clauses.is_empty() {
        return "Finished. Nothing was left to commit or push.".to_string();
    }
    // Every clause is written verb-first, so the sentence reads the same way
    // the rest of this page does — the system as the actor — and so the one
    // that starts it can be capitalised without touching a repository's name.
    let mut said = clauses.join("; ");
    if let Some(first) = said.get_mut(0..1) {
        first.make_ascii_uppercase();
    }
    format!("Finished. {said}.")
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
        (PausedReason::FiveRuns, f, q) => {
            format!("after five runs in a row did not finish — {f} failed and {q} stopped to ask")
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use ft_core::{CheckoutSummary, WorkSummary};

    /// One checkout, as the worker reports it.
    fn checkout(slug: &str, branch: &str) -> CheckoutSummary {
        CheckoutSummary {
            path: String::new(),
            slug: slug.into(),
            summary: WorkSummary {
                branch: branch.into(),
                uncommitted: 0,
                ahead: 0,
                pushed: true,
                commits: Some(0),
                unborn: false,
            },
            trouble: None,
        }
    }

    /// **The one Kevin caught: a push that never happened.**
    ///
    /// The line asserted "Pushed {branch}" from the outcome being `Clean` and
    /// a branch name existing. `Clean` is equally true of an agent that
    /// changed nothing — Firetower cuts the branch either way — so a run that
    /// did nothing announced a push. `commits` is the field that answers it,
    /// and it is the only one that can: `ahead` starts measuring against the
    /// upstream the moment a branch exists on the remote, so a pushed branch
    /// holding nothing also reports `ahead: 0`.
    #[test]
    fn a_clean_run_that_pushed_nothing_does_not_claim_it_pushed() {
        let said = says(&[checkout("acme/web", "agent/test3-3")]);
        assert_eq!(said, "Finished. Nothing was left to commit or push.");
        assert!(!said.contains("Pushed"), "{said}");
        assert!(!said.contains("agent/test3-3"), "{said}");
    }

    #[test]
    fn a_run_that_did_push_says_how_much() {
        let mut one = checkout("acme/web", "agent/bumps");
        one.summary.commits = Some(3);
        assert_eq!(says(&[one]), "Finished. Pushed 3 commits to agent/bumps.");

        let mut just_one = checkout("acme/web", "agent/bumps");
        just_one.summary.commits = Some(1);
        assert_eq!(
            says(&[just_one]),
            "Finished. Pushed 1 commit to agent/bumps."
        );
    }

    /// **A worker too old to count says nothing about pushing**, rather than
    /// either claiming or denying one. What it does say — nothing left to
    /// commit or push — is carried by `uncommitted` and `ahead`, which it does
    /// report.
    #[test]
    fn an_uncountable_push_is_left_unsaid() {
        let mut one = checkout("acme/web", "agent/bumps");
        one.summary.commits = None;
        assert_eq!(
            says(&[one]),
            "Finished. Nothing was left to commit or push."
        );
    }

    /// **The second arm, which had the same shape.** "Work was left on
    /// {branch}" was asserted of every outcome that was not clean — including
    /// a branch that was never pushed and has nothing on it, where no work
    /// was left at all.
    #[test]
    fn what_was_left_is_counted_rather_than_assumed() {
        let mut files = checkout("acme/web", "agent/x");
        files.summary.uncommitted = 3;
        assert_eq!(
            says(&[files]),
            "Finished. Left 3 files uncommitted on agent/x."
        );

        let mut unpushed = checkout("acme/web", "agent/x");
        unpushed.summary.pushed = false;
        unpushed.summary.ahead = 2;
        unpushed.summary.commits = Some(2);
        assert_eq!(
            says(&[unpushed]),
            "Finished. Left 2 commits unpushed on agent/x."
        );

        let mut both = checkout("acme/web", "agent/x");
        both.summary.uncommitted = 1;
        both.summary.ahead = 4;
        assert_eq!(
            says(&[both]),
            "Finished. Left 1 file uncommitted and 4 commits unpushed on agent/x."
        );

        // Not pushed, and nothing on it: `Kept`, and nothing to report.
        let mut empty = checkout("acme/web", "agent/x");
        empty.summary.pushed = false;
        assert_eq!(
            says(&[empty]),
            "Finished. Nothing was left to commit or push."
        );
    }

    /// A checkout the worker could not inspect says that, and says nothing
    /// about what is in it.
    #[test]
    fn an_unreadable_checkout_names_itself_and_the_trouble() {
        let mut bad = checkout("acme/web", "agent/x");
        bad.trouble = Some("not a git repository".into());
        bad.summary.uncommitted = 9;
        assert_eq!(
            says(&[bad]),
            "Finished. Could not read acme/web: not a git repository."
        );
    }

    /// **Two branches, two stories, and the first does not speak for both.**
    #[test]
    fn every_checkout_with_something_to_say_says_it() {
        let mut pushed = checkout("acme/web", "agent/web");
        pushed.summary.commits = Some(2);
        let mut left = checkout("acme/api", "agent/api");
        left.summary.uncommitted = 1;
        assert_eq!(
            says(&[pushed, left]),
            "Finished. Pushed 2 commits to agent/web; left 1 file uncommitted on agent/api."
        );
    }
}
