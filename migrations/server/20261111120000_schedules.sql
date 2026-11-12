-- Schedules: a durable authorization to start an agent with nobody present.
--
-- Three things are worth reading before changing this.
--
-- **The trigger is a cron today and must not be the only kind this can
-- express.** Webhooks, GitHub Actions and API calls are stated future work, so
-- the trigger is its own table below rather than two columns here: a webhook
-- needs a hashed bearer credential, a delivery id to deduplicate on and a rate
-- limit, and four nullable columns for a kind this row does not have is how a
-- table stops being readable.
--
-- **Not filed, and that is deliberate.** No `path`, no `extra_perms`, no
-- `filed_where` — the design settled that a schedule is not shared, so the
-- question collapses to "is it mine" exactly as it does for a repository
-- (`db.rs`'s `repos_of`). The day sharing is wanted it is one migration adding
-- `path` and switching the reads, which is what `FiledKind` exists for.
--
-- **The history does not hang off the workspace.** Same argument as
-- `20261023120000_artifacts.sql`, and here it is sharper: `reclaim.rs` deletes
-- a workspace within a minute of its last session ending, with no grace
-- period, and the cascade takes the sessions and `agent_lines` with it. A run
-- history built from `sessions` would evaporate, and would evaporate faster
-- the more the schedule is used. The link may go; the line stays.

create table schedules (
    id                text primary key,
    org_id            text not null references organizations(id) on delete cascade,
    -- Who it runs as: the subscription spent, the token that pushes, the
    -- repositories reachable. Separate from whoever typed it, because those
    -- come apart the moment an agent proposes one.
    owner_id          text not null references users(id) on delete cascade,
    created_by        text not null references users(id),
    -- The conversation that asked for it, when an agent did. Text, copied,
    -- never a foreign key — `reclaim.rs` deletes that session within the
    -- minute, and `artifacts.from_session_id` is the precedent.
    from_session_id   text,
    name              text not null,
    -- What runs. A whole `NewSession`, as approved.
    spec              jsonb not null,
    -- What was resolved at approval and must not be resolved again: skill
    -- version ids, the profile revision and its composed persona, the account
    -- id, and all four control fields explicitly.
    --
    -- An unset control field is not a safe thing to store. `carry_preferences`
    -- (`sessions.rs`) fills any unset field of `settings` from whatever that
    -- person was last working with, so `settings: {}` does not mean "the
    -- defaults" — it means "whatever they were doing at 5pm yesterday", and it
    -- would change what the 9am unattended run does.
    pins              jsonb not null,
    -- Approval. Null until a person turns it on, which is the whole of the
    -- "an agent may propose but not activate" rule. An edit bumps `revision`
    -- and clears these two, so the next run is refused until somebody looks.
    approved_by       text references users(id),
    approved_at       timestamptz,
    revision          integer not null default 1,
    active            boolean not null default false,
    -- Why it is not running, when a schedule paused itself. Null when a
    -- person paused it — "you paused this" and "this gave up" have to read
    -- differently, and a null is the cheapest way to tell them apart.
    --
    -- **Which rule fired, and nothing more**: `three_failures`, `five_runs`,
    -- `overran` or `owner_disabled`. Not a composed sentence and not a tally.
    -- The streak is the leading part of the history the page already draws,
    -- so it can count the failures and the questions itself and say the exact
    -- shape — including the mixed case, which no single rule name covers. A
    -- sentence composed here would be a second copy of that, free to disagree
    -- with it, and it would need a tie-break between two words. There is no
    -- tie-break: the words are derived, so nothing has to pick.
    paused_reason     text,
    -- The one column the keep/delete switch needs.
    delete_clean_runs boolean not null default true,
    -- **No cap on kept workspaces, by decision.** There is deliberately no
    -- `keep_at_most` here and no per-person equivalent anywhere else: a
    -- ceiling nobody agreed to must not arrive as a default, and deleting the
    -- oldest kept run would destroy a failure's conversation before anybody
    -- read it.
    --
    -- What bounds the pile is not here at all. It is the disk floor in
    -- `create_session_as`: old work is never deleted on a count, and new work
    -- stops being started once the machine is low. The count on
    -- `schedule_runs.workspace_kept` is what makes the pile legible.
    --
    -- **And no `catch_up_within`.** Nothing is ever run late, so there is no
    -- window to configure. A column expressing a decision that went the other
    -- way is a question a future reader would try to answer.
    --
    -- How long a run may be working before it is recorded as having overrun.
    -- The run is never stopped; the *schedule* pauses on the second
    -- observation. Stopping it would delete the conversation that explains
    -- why it overran, by the same sweep that reports it.
    max_runtime       interval not null default '2 hours',
    -- How long an unanswered question waits before the run is settled as
    -- `needs_you` and the schedule is free to run again. **This ends the
    -- waiting, not the run**: the agent stays parked and the workspace
    -- stands, because ending it would delete the question inside a minute.
    needs_you_within  interval not null default '15 minutes',
    -- **No `consecutive_failures` column.** The auto-pause streak is derived
    -- from `schedule_runs` instead — one indexed read of
    -- `schedule_runs_history`, limit 50, at each run completion. A column here
    -- would have three writers (settle, the orphan reconciler, the overrun
    -- observer) and would need a backfill, all to cache an answer the history
    -- already holds. The history is append-only, so it cannot drift from
    -- itself.
    --
    -- **Two bounds, one streak: three failures, or five counted runs of any
    -- kind.** Not two counters — `failed, needs_you, failed, needs_you…`
    -- would trip neither. And not "every run that was not clean": `refused`,
    -- `missed`, `skipped`, `lost` and `overran` are transparent, stepped over
    -- as though absent, while a run that completed resets the streak.
    --
    -- There is no unreachable-machine exception. An unreachable failure does
    -- not count toward the three and so is bounded by the five, which is what
    -- the exception did — as the general rule rather than as a special case.
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now()
);

-- The trigger. One row is a cron; the kinds below it are the stated future,
-- and each will want its own columns inside `config` rather than here.
create table schedule_triggers (
    id            text primary key,
    schedule_id   text not null references schedules(id) on delete cascade,
    kind          text not null constraint schedule_triggers_kind
                    check (kind in ('cron')),
    -- {"expr":"0 9 * * 1-5","tz":"Europe/Paris"} for a cron. Validated on
    -- write by that kind's own validator and never read as a bag. The IANA
    -- name, not an offset: an offset is wrong twice a year.
    config        jsonb not null,
    enabled       boolean not null default true,
    -- When this trigger next wants a run, computed in Rust and written back.
    -- **Postgres compares timestamps; it does not learn cron.** This column is
    -- the whole of the clock's index.
    next_fire_at  timestamptz,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

-- One row per occurrence. Its own table, not a view over sessions — see the
-- head of this file for why.
create table schedule_runs (
    id            text primary key,
    schedule_id   text not null references schedules(id) on delete cascade,
    trigger_id    text references schedule_triggers(id) on delete set null,
    -- Which occurrence this is. The unique index below is the claim.
    fire_at       timestamptz not null,
    -- Which approved revision ran. "Why did it do that" is asked after the
    -- schedule has been changed, so the answer has to be on the run.
    revision      integer not null,
    state         text not null check (state in (
                      'claimed',   -- taken, not yet launched
                      'running',   -- a session exists
                      'finished',  -- it ended; see `outcome`
                      'skipped',   -- the previous run was still going
                      'refused',   -- a gate said no, before the vault
                      'failed',    -- the launch or the run broke
                      'missed',    -- the control plane was not running
                      'lost')),    -- the control plane died mid-launch
    -- Four, not three. `unknown` is "could not tell": classifying a run needs
    -- `fleet.summarize`, a live round trip, and a machine that went away after
    -- the run finished cannot be asked. The workspace is kept either way; the
    -- history line must not claim it was kept *because* of uncommitted work.
    outcome       text check (outcome in ('clean', 'kept', 'needs_you', 'overran', 'unknown')),
    -- Why, in the words the history line shows. Written once.
    detail        text,
    -- A **copy** of `sessions.proposed_title`, taken before the workspace is
    -- torn down. Not a join: `describe()` writes that column seconds after a
    -- hand-back, and `reclaim.rs` deletes it a minute after the end.
    summary       text,
    -- The workspace this run made, while there is one to open.
    --
    -- **Copied text, and deliberately not a foreign key**, which is a
    -- correction to the design rather than an omission. The scheduler mints
    -- the session id and writes it here *before* it attempts the launch, so
    -- that a control plane replaced mid-launch — the ordinary way this process
    -- ends — leaves a claim that can be reconciled: "does a session with this
    -- id exist?" separates "nothing ran, no credential was read" from the
    -- rest, because `insert_session` is the first thing in a launch that
    -- commits. A foreign key makes that write impossible, because at that
    -- moment the session does not exist yet.
    --
    -- What the key was for was `on delete set null`, so the link went when
    -- `reclaim` purged the workspace and the line stayed. That still happens,
    -- and `workspace_kept` below is what says it: a real column rather than
    -- `session_id is not null`, for reasons of its own. So a client asks
    -- `workspace_kept` whether there is a workspace to open, and this column
    -- is what to open — the same discipline `host_name` follows one line
    -- down, and the same one `artifacts.from_session_id` follows for the same
    -- reason.
    --
    -- It also takes `schedule_runs` out of the way of the purge entirely:
    -- `reclaim::sweep` runs sixty times a minute, and nothing it does now
    -- writes to this table.
    session_id    text,
    -- Copied, for the same reason: a machine can be retired, and the history
    -- still has to be able to say where this ran.
    host_name     text,
    -- Which kind of trigger started this, copied at claim time, or 'manual'
    -- for Run now. **The auto-pause counts scheduled runs only**, and
    -- `trigger_id` cannot answer that: it is `on delete set null`, so a
    -- deleted trigger would make a historical scheduled run look
    -- hand-started. Copied rather than joined, like `host_name`. It is also
    -- the column the webhook and API triggers will want.
    source        text not null,
    -- The `ErrorCode` verbatim, null unless the launch failed or was refused.
    -- **The auto-pause needs to tell `HostUnreachable` from every other
    -- failure**, and `detail` is prose written for a person, which is never a
    -- predicate. It also makes the error mapping something the code can
    -- assert rather than something a reader has to trust.
    error_code    text,
    -- Whether this run is still holding a workspace. A real column, not
    -- derived from `session_id`: that goes null the moment `reclaim` purges a
    -- deleted run, so a count reading it would quietly fall to zero exactly
    -- as the real number climbed. With no cap, this count is the only thing
    -- standing between a schedule and a full disk on somebody's machine.
    workspace_kept boolean not null default false,
    claimed_at    timestamptz not null default now(),
    launched_at   timestamptz,
    ended_at      timestamptz
);

-- **Not for reading.** It is the claim — the `on conflict` target, and the
-- only thing standing between one fire time and two agents. If one line of
-- this migration has to be right, it is this one.
create unique index schedule_runs_occurrence on schedule_runs (schedule_id, fire_at);

-- The one query the clock runs. Partial, so a paused schedule's triggers —
-- whose `next_fire_at` is nulled when it pauses — are not in the index at
-- all: it stays the size of the active set rather than of the library.
create index schedule_triggers_due on schedule_triggers (next_fire_at)
    where enabled and next_fire_at is not null;

-- Two hot questions, one index: "is a run of this schedule still going?" and
-- "which runs need settling?". Partial, so it is the size of the fleet's live
-- work and not of all history.
create index schedule_runs_live on schedule_runs (schedule_id)
    where state in ('claimed', 'running');

-- The twenty rows the detail page draws, newest first, with the ordering in
-- the index so the page never sorts. Mirrors `artifact_versions_by_artifact`.
create index schedule_runs_history on schedule_runs (schedule_id, fire_at desc);

-- The library list. Shaped exactly like `artifacts_by_owner`, for the same
-- screen.
create index schedules_by_owner on schedules (owner_id, updated_at desc);

-- "Which run is this workspace from?", asked from a session rather than from a
-- schedule. Smaller than it was going to be: with `session_id` a copy rather
-- than a foreign key, `reclaim`'s purge no longer writes here at all, so this
-- is for reading rather than for keeping a cascade off a sequential scan.
create index schedule_runs_by_session on schedule_runs (session_id);
