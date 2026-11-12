//! The clock, and what happens when it fires.
//!
//! An eighth `tokio::spawn` beside [`crate::reclaim::watch`]. A 60-second
//! sweep that asks "which are due?", not a timer per schedule and not a system
//! cron.
//!
//! **Why in-process.** A launch needs `AppState`, and `AppState` cannot be had
//! from outside this process: `fleet` is a map of live sockets and `vault`
//! holds the root key, with "one copy of that in memory is enough" written on
//! the field itself. `delegate.rs` already made and won this argument — the
//! fleet's connection loop "has no business starting sessions and nothing to
//! start them with", so the request is handed to something that has
//! `AppState`. A system cron has the same deficit and no channel, and it would
//! need a durable credential for a timer, which is the thing the threat model
//! refuses outright.
//!
//! **No queue.** It needs one row per occurrence, which is the part of a queue
//! that matters, and `unique (schedule_id, fire_at)` with
//! `ON CONFLICT DO NOTHING RETURNING id` *is* the lock. `SKIP LOCKED` buys
//! nothing with a single consumer: a locked row would be retried on the next
//! tick sixty seconds later, which is what the conflict already gives for
//! free.
//!
//! **Nothing is ever run late.** An occurrence whose fire time passed while
//! this process was not running is recorded `missed`, however recently it was
//! due. Taken knowing that the control plane is routinely replaced by its own
//! updater, which `updates::status::watch` calls the ordinary way it ends — so
//! this bites on ordinary upgrades, not only on outages. The defence is that
//! the alternative is work at a time nobody chose: losing a 09:00 run is
//! legible, and starting it at 09:03 on a control plane that is still settling
//! is a surprise. It is never silent — a missed occurrence is a history line
//! that says the control plane was not running.
//!
//! The boundary for "late" is **this process's start time**, captured once —
//! see [`watch`]. Taken literally, "never run an occurrence already in the
//! past" would have the sweep's own start-up settle destroy anything due
//! inside it.

use crate::AppState;
use chrono::{DateTime, Utc};
use ft_core::schedule::{Cadence, PausedReason, RunSource, TriggerKind};
use ft_core::{ScheduleId, ScheduleRunId, TriggerId};
use std::time::Duration;

pub mod cadence;
pub mod launch;
pub mod pause;
pub mod settle;

/// How often to look.
///
/// `reclaim.rs`'s own interval, deliberately: two sweeps, one number to learn
/// and one argument to read. Its comment already wrote the justification — a
/// tighter loop would be "a query per second against a table that changes a
/// few times an hour".
///
/// **This is punctuality, and it is not the number to change if a backlog ever
/// drains slowly.** That is [`AT_ONCE`]. Tightening this would ask the same
/// question twice as often without draining any faster per pass. And nothing
/// downstream can tell the difference: the row renders `HH:MM` and nothing
/// finer, so a run starting at 09:00:58 and one starting at 09:00:28 both read
/// 09:00. If a page ever shows seconds, or a relative string that ticks, that
/// changes and this is worth reopening.
const EVERY: Duration = Duration::from_secs(60);

/// The most occurrences to start in one pass.
///
/// A cap rather than a batch size: a backlog is worked off over several
/// passes. A hundred schedules all due at 09:00 drain in five passes.
const AT_ONCE: i64 = 20;

/// How many scheduled launches may be cutting a worktree at once.
///
/// Three, and the argument for it is on `launch::permits`, which is where it
/// is applied: a pass does not know which machine anything will land on, so a
/// cap keyed on a machine was unreachable for every schedule that names none
/// — which is all of them, by design.
pub(crate) const AT_ONCE_PER_HOST: usize = 3;

/// How long before the first pass.
///
/// Longer than `reclaim`'s own thirty seconds, and for a reason of its own: a
/// host that is coming back is noticed within `RETRY_CAP`, and a run started
/// before then fails as `HostUnreachable` — which joins the streak. A sweep
/// must not move a schedule toward pausing because the control plane had just
/// restarted.
const SETTLE_IN: Duration = Duration::from_secs(90);

/// How long a claim may sit before it is treated as abandoned.
///
/// It has to clear the slowest legitimate launch or the reconciler starts
/// adopting work that is merely slow. The worst honest case is
/// `RECONNECT_GRACE` at 30s, plus `check_readiness` at "a 30-second round trip
/// per host", plus `PROBE_TIMEOUT` at 30s for each repository whose trunk is
/// still unknown, plus the vault reads — a shade over two minutes for a
/// two-repository session.
///
/// Five is roughly double that and well under the shortest interval a schedule
/// may have, which [`cadence::MIN_INTERVAL`] fixes at fifteen minutes. Both
/// numbers want to move together if either moves.
///
/// Derived from how long a launch takes, not from how often the sweep looks:
/// the sweep interval only affects how soon an orphan is noticed after the
/// fence expires.
const ORPHAN_AFTER: chrono::TimeDelta = chrono::TimeDelta::minutes(5);

/// How long to wait for `describe()` before settling a run without a summary.
///
/// A hand-back spawns a short-lived agent on the host to write
/// `sessions.proposed_title`, which takes seconds and may land after the sweep
/// next looks. Rather than settle with an empty summary, a run is left one
/// more pass — and after this, settled with whatever git can see instead.
const SUMMARY_GRACE: chrono::TimeDelta = chrono::TimeDelta::minutes(2);

/// For as long as the control plane runs.
pub async fn watch(state: AppState) {
    // **Captured before the delay, not after.** This is the boundary between
    // "due while we were not running" and "due since we started": an
    // occurrence due during the settle below still runs, because the process
    // was there for it. Reading the clock after the sleep would make the
    // start-up settle destroy ninety seconds of occurrences on every upgrade,
    // which is the one place the never-catch-up ruling needed interpreting
    // rather than implementing.
    let booted = Utc::now();
    tokio::time::sleep(SETTLE_IN).await;
    loop {
        match sweep(&state, booted).await {
            Ok(0) => {}
            Ok(n) => tracing::info!("started {n} scheduled run(s)"),
            Err(e) => tracing::warn!("starting scheduled runs: {e:#}"),
        }
        tokio::time::sleep(EVERY).await;
    }
}

/// One pass. Returns how many runs were started.
///
/// Three phases, in this order, because each wants the one before it to have
/// finished: a reconciled claim is one the overlap check no longer counts as
/// busy, and a settled run is one the next occurrence is no longer skipped
/// behind.
pub async fn sweep(state: &AppState, booted: DateTime<Utc>) -> anyhow::Result<usize> {
    // Not needed for correctness — the unique index stops a double launch and
    // every settle step is a compare-and-set. What it buys is that two control
    // planes degrade to one scheduler and one idle loop, which is a sentence
    // somebody can write down.
    let Some(lock) = state.db.take_scheduler_lock().await? else {
        tracing::debug!("another control plane holds the scheduler; idling");
        return Ok(0);
    };

    let now = Utc::now();
    let outcome = async {
        // What the foreign key on `session_id` used to do. It is a copy now —
        // it has to be, because it is written before the session exists — so
        // a workspace `reclaim` purged out from under a kept run is forgotten
        // here rather than by a cascade.
        if let Ok(n) = state.db.forget_purged_workspaces().await {
            if n > 0 {
                tracing::debug!("{n} scheduled run(s) stopped holding a workspace");
            }
        }
        reconcile(state, now).await?;
        settle::pass(state, now).await?;
        due(state, now, booted).await
    }
    .await;

    lock.release().await;
    outcome
}

/// Claims nobody is working on.
///
/// The run is claimed before the session exists and `create_session_as` is not
/// idempotent, so a crash between the two leaves an occurrence claimed with
/// nothing running — and no second process will ever re-claim it, because the
/// index says it is taken.
///
/// Two guards, one for each kind of stale claim. Within this process, the
/// launches in flight are skipped: one taking ninety seconds is not an orphan.
/// Across a restart that set is empty, so the fence is time.
///
/// What the id minted in the scheduler buys is the one question that separates
/// the windows: **does a session with this id exist?** `insert_session` is the
/// first thing in a launch that *commits a row*, so a claim naming no session
/// means nothing was recorded and no workspace was made.
///
/// **It does not mean no credential was read**, and the backend scope and an
/// earlier version of this comment both said it did. Choosing a host probes a
/// repository whose trunk is still unknown, and that probe is handed a git
/// credential — so a crash before `insert_session` can still have read one
/// out of the vault. The vault's own log is the record of that, which is why
/// every read names the session it was for. Nothing here changes; what
/// changes is the claim, because the next person to reason about this window
/// would otherwise build on a guarantee that does not exist.
///
/// A claim naming a session that exists is
/// either a session no worker ever heard of or a real agent nobody is
/// recording — and those two are *not* distinguishable here, because
/// `fleet.send` writes to a socket and nothing in the database records that it
/// arrived. Both are adopted, which is right for the second and harmless for
/// the first: it then sits at `Starting` until `max_runtime`, when the overrun
/// rule says so.
async fn reconcile(state: &AppState, now: DateTime<Utc>) -> anyhow::Result<()> {
    let in_flight = launch::in_flight().await;
    for run in state.db.live_runs().await? {
        if run.state != "claimed" || in_flight.contains(run.id.as_str()) {
            continue;
        }
        if now - run.claimed_at < ORPHAN_AFTER {
            continue;
        }

        let started = match &run.session_id {
            Some(session) => state.db.session_exists(session).await?,
            None => false,
        };

        if let (true, Some(session)) = (started, run.session_id.as_ref()) {
            // Adopted, and the two cases that reach here are not
            // distinguishable: a session row no worker ever heard of, and a
            // real agent whose run row does not know about it. Adopting is
            // right for the second and harmless for the first — within one
            // sweep the run is `running` with the right session, and nothing
            // was lost but a minute of the history being wrong.
            //
            // The honest cost of not telling them apart: a ghost then sits at
            // `Starting` until `max_runtime`, when the overrun rule says so.
            // That composition is the backstop, and it is why the overrun
            // deadline earns its place even though it never stops anything.
            let host = match state.db.session(session).await? {
                Some(s) => state
                    .db
                    .host_by_id(&s.host_id)
                    .await?
                    .map(|h| h.name)
                    .unwrap_or_default(),
                None => String::new(),
            };
            let _ = state.db.run_launched(&run.id, session, &host).await;
            continue;
        }

        // A sentence rather than a state. `lost` on its own is a word that
        // invites a support ticket. It says nothing was *started*, which is
        // true, and does not claim nothing was read — see above.
        let settled = state
            .db
            .settle_run(
                &run.id,
                "lost",
                None,
                Some("Did not start. The control plane restarted while this run was starting."),
                None,
                None,
                false,
            )
            .await?;
        if settled {
            // **Never retried.** Nothing is ever run late, so this needs no
            // judgement — the catch-up decision removed the only hard question
            // the reconciler would have had.
            tracing::info!(run = %run.id, "a claim from before a restart was recorded lost");
            settle::after_terminal(state, &run.schedule_id).await?;
        }
    }
    Ok(())
}

/// The due phase: one occurrence per trigger that wants one.
async fn due(state: &AppState, now: DateTime<Utc>, booted: DateTime<Utc>) -> anyhow::Result<usize> {
    let wanted = state.db.schedules_due(now, AT_ONCE).await?;
    if wanted.is_empty() {
        return Ok(0);
    }

    let mut started = 0usize;

    for trigger in wanted {
        let Some(schedule) = state.db.schedule(&trigger.schedule_id).await? else {
            continue;
        };
        let Some(clock) = clock_of(&trigger.config) else {
            // A trigger this build cannot read is left alone rather than
            // nulled: a kind added by a later build must not be quietly
            // disarmed by an older one that happens to run next.
            tracing::warn!(trigger = %trigger.trigger_id, "a trigger this build cannot read");
            continue;
        };

        let Some(was_due) = trigger.due_at else {
            continue;
        };

        // Every occurrence between where the clock stood and now, and where it
        // lands next. `capped` means the gap was longer than the cap and one
        // row names the period instead of one row per occurrence.
        let (passed, next, capped) = clock.between(was_due - chrono::TimeDelta::seconds(1), now);
        state.db.set_next_fire_at(&trigger.trigger_id, next).await?;

        if capped {
            // One row, naming the period. A fifteen-minute schedule left alone
            // for a year is thirty-five thousand occurrences, and thirty-five
            // thousand history lines say nothing a single one does not.
            let first = passed.first().copied().unwrap_or(was_due);
            let last = passed.last().copied().unwrap_or(now);
            let _ = state
                .db
                .claim_run(
                    &ScheduleRunId::new(),
                    &trigger.schedule_id,
                    Some(&trigger.trigger_id),
                    first,
                    trigger.revision,
                    source_of(&trigger.kind),
                    "missed",
                    Some(&format!(
                        "Missed. Firetower was not running between {} and {}, so {} runs did not \
                         happen. A missed run is never made up.",
                        first.format("%-d %B %H:%M"),
                        last.format("%-d %B %H:%M"),
                        passed.len(),
                    )),
                    false,
                )
                .await?;
            continue;
        }

        // Oldest first, so the one that actually runs is the newest.
        let mut occurrences = passed;
        occurrences.sort();
        let youngest = occurrences.pop();

        // Everything before the newest is behind the clock by more than one
        // interval, and nothing is ever run late.
        for missed in &occurrences {
            record_missed(state, &trigger, *missed, booted).await?;
        }

        let Some(fire_at) = youngest else {
            continue;
        };

        // **Due while the control plane was not running.** The boundary is the
        // process's start time, captured once at boot — not "in the past",
        // which would make the sweep's own settle destroy runs.
        if fire_at < booted {
            record_missed(state, &trigger, fire_at, booted).await?;
            continue;
        }

        // A run still launching or working blocks the next occurrence; one
        // parked at a question does not. Claimed and recorded rather than
        // silently omitted, so the history says a run was due and why it did
        // not happen.
        if trigger.busy {
            let _ = state
                .db
                .claim_run(
                    &ScheduleRunId::new(),
                    &trigger.schedule_id,
                    Some(&trigger.trigger_id),
                    fire_at,
                    trigger.revision,
                    source_of(&trigger.kind),
                    "skipped",
                    Some("Skipped. The previous run was still going."),
                    false,
                )
                .await?;
            settle::after_terminal(state, &trigger.schedule_id).await?;
            continue;
        }

        let Some(claim) = state
            .db
            .claim_run(
                &ScheduleRunId::new(),
                &trigger.schedule_id,
                Some(&trigger.trigger_id),
                fire_at,
                trigger.revision,
                source_of(&trigger.kind),
                "claimed",
                None,
                true,
            )
            .await?
        else {
            // Somebody else has this occurrence, which is fine and is not
            // worth counting — `reclaim::sweep`'s words for the same case.
            continue;
        };

        // Bounded inside the launch rather than here — a pass does not know
        // which machine anything will land on, and that is what made the
        // per-host cap unreachable for an ordinary schedule. See
        // `launch::permits`.
        launch::spawn(state.clone(), schedule, claim, launch::Why::Clock);
        started += 1;
    }

    Ok(started)
}

/// Record an occurrence that will never be run.
async fn record_missed(
    state: &AppState,
    trigger: &crate::db::DueTrigger,
    fire_at: DateTime<Utc>,
    _booted: DateTime<Utc>,
) -> anyhow::Result<()> {
    let taken = state
        .db
        .claim_run(
            &ScheduleRunId::new(),
            &trigger.schedule_id,
            Some(&trigger.trigger_id),
            fire_at,
            trigger.revision,
            source_of(&trigger.kind),
            "missed",
            Some(&format!(
                "Missed. Firetower was not running at {}. A missed run is never made up.",
                fire_at.format("%H:%M")
            )),
            false,
        )
        .await?;
    if taken.is_some() {
        // `missed` is transparent to the pause rule, so this can never move a
        // schedule toward pausing — but the streak is recomputed anyway,
        // because the rule is "after every run that reaches a terminal state"
        // and carving out exceptions is how a rule acquires a second one.
        settle::after_terminal(state, &trigger.schedule_id).await?;
    }
    Ok(())
}

/// Which trigger kind fired a run, for the history.
///
/// Copied at claim time rather than joined through `trigger_id`, which is
/// `on delete set null` — a deleted trigger would otherwise make a historical
/// scheduled run look hand-started, and the pause rule reads this column.
fn source_of(kind: &str) -> &'static str {
    match kind {
        "cron" => "cron",
        // A kind this build does not know still has to be recorded as *not*
        // manual, because the alternative is laundering it past the pause
        // rule.
        _ => "trigger",
    }
}

/// The clock a trigger's stored config describes.
pub fn clock_of(config: &serde_json::Value) -> Option<cadence::Clock> {
    let cadence: Cadence = serde_json::from_value(config.get("cadence")?.clone()).ok()?;
    let tz = config.get("tz")?.as_str()?;
    cadence::Clock::of(&cadence, tz).ok()
}

/// What a trigger's config holds, for one cadence in one zone.
///
/// The cadence is stored beside the expression it compiles to rather than
/// derived back out of it: reversing a cron expression into "every weekday at
/// 08:30" is guesswork, and it gets it wrong for exactly the expressions
/// somebody wrote by hand.
pub fn trigger_config(
    cadence: &Cadence,
    timezone: &str,
    clock: &cadence::Clock,
) -> serde_json::Value {
    serde_json::json!({
        "cadence": cadence,
        "tz": timezone,
        "expr": clock.expr(),
    })
}

/// The one kind there is.
pub fn kind_name(kind: TriggerKind) -> &'static str {
    match kind {
        TriggerKind::Cron => "cron",
    }
}

/// An `ErrorCode` as the column stores it.
///
/// The variant name verbatim, which is what the enum serializes to and what
/// `pause::does` matches against. Through serde rather than a second `match`,
/// so a renamed variant cannot leave the two disagreeing.
pub fn error_code(code: crate::api::ErrorCode) -> String {
    serde_json::to_value(code)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "Internal".to_string())
}

/// How a run was started, for a client.
pub fn run_source(stored: &str) -> RunSource {
    match stored {
        "manual" => RunSource::Manual,
        _ => RunSource::Cron,
    }
}

/// Which rule a stored `paused_reason` names.
pub fn paused_reason(stored: Option<&str>) -> Option<PausedReason> {
    match stored? {
        "three_failures" => Some(PausedReason::ThreeFailures),
        "five_runs" => Some(PausedReason::FiveRuns),
        "overran" => Some(PausedReason::Overran),
        "owner_disabled" => Some(PausedReason::OwnerDisabled),
        // A value a later build wrote. Reading it as "a person paused this"
        // would be wrong, and reading it as any particular rule would be a
        // guess, so it is dropped — the page then says the plainest true
        // thing, which is that it is off.
        _ => None,
    }
}

/// What a `PausedReason` is stored as.
pub fn reason_name(reason: PausedReason) -> &'static str {
    match reason {
        PausedReason::ThreeFailures => "three_failures",
        PausedReason::FiveRuns => "five_runs",
        PausedReason::Overran => "overran",
        PausedReason::OwnerDisabled => "owner_disabled",
    }
}

/// The trigger a schedule's row has, as a client reads it.
pub fn trigger_of(row: &crate::db::TriggerRow, active: bool) -> Option<ft_core::schedule::Trigger> {
    let cadence: Cadence = serde_json::from_value(row.config.get("cadence")?.clone()).ok()?;
    let timezone = row.config.get("tz")?.as_str()?.to_string();
    let clock = cadence::Clock::of(&cadence, &timezone).ok()?;
    Some(ft_core::schedule::Trigger {
        id: TriggerId::from_stored(row.id.as_str()),
        kind: TriggerKind::Cron,
        cadence,
        timezone,
        enabled: row.enabled,
        expr: clock.expr().to_string(),
        reads: clock.reads(),
        // **Empty while it is off.** A schedule that is not running has no
        // next run to name, and three future times beside the word Stopped
        // would be three promises nothing is going to keep.
        next_fires: match active && row.enabled {
            true => clock.next_fires(Utc::now(), 3),
            false => Vec::new(),
        },
        next_fire_at: row.next_fire_at,
    })
}

/// Where to point somebody at a schedule.
pub fn schedule_url(state: &AppState, id: &ScheduleId) -> Option<String> {
    let base = state.public_url.trim_end_matches('/');
    (!base.is_empty()).then(|| format!("{base}/schedules/{id}"))
}
