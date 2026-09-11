-- Upgrades, run from the control plane rather than by hand on each machine.
--
-- Three things worth keeping. What the last check of the releases found, so
-- the rail can say "0.31.0 is available" without asking GitHub on every page
-- load. Each upgrade that was run, so somebody can see what happened to their
-- fleet last Tuesday. And each step of each run, which is where the log lives
-- — the control plane recreates itself in the middle of a run, and a run that
-- lived in memory would come back as nothing.

-- What the releases feed said, the last time it was asked. One row.
create table update_checks (
    singleton       boolean primary key default true check (singleton),
    checked_at      timestamptz not null,
    -- Absent when the check failed; `error` then says why.
    latest_version  text,
    published_at    timestamptz,
    notes_url       text,
    -- The release's own notes, as GitHub holds them: the changelog section.
    notes           text,
    -- The least CLI that release wants on the operator's machine, from
    -- deploy/cli.json at the tag. Reported, never enforced from here.
    cli_minimum     text,
    error           text
);

create table update_runs (
    id            text primary key,
    from_version  text not null,
    to_version    text not null,
    -- {"controlPlane": bool, "hostIds": [...]}.
    targets       jsonb not null,
    -- Drain and wait for every targeted host to be idle, rather than ending
    -- what is running on it.
    when_idle     boolean not null default false,
    -- The deployment files to rewrite and their new contents, decided when the
    -- run was planned and carried in the run so the person who approved a diff
    -- gets exactly that diff applied.
    plan          jsonb not null default '{}'::jsonb,
    -- planned | waiting_idle | running | succeeded | failed | cancelled
    state         text not null,
    started_by    text references users(id) on delete set null,
    created_at    timestamptz not null default now(),
    started_at    timestamptz,
    finished_at   timestamptz,
    error         text
);

create table update_steps (
    run_id       text not null references update_runs(id) on delete cascade,
    position     integer not null,
    -- control_plane | updater | host:<host id>
    target       text not null,
    -- One line for the screen: what this step is, said before it runs.
    title        text not null,
    -- pending | running | done | failed | skipped
    state        text not null default 'pending',
    started_at   timestamptz,
    finished_at  timestamptz,
    -- One line, said after: what it did, or why it did not.
    detail       text,
    -- What was run and what it said. Redacted before it is written, bounded.
    log          text not null default '',
    -- The updater's job id, for a step the updater runs: how a control plane
    -- that was recreated in the middle of it finds out how it went.
    job_id       text,
    -- Whether the host was already drained before this run drained it, so
    -- finishing puts it back the way it was found.
    was_drained  boolean,
    primary key (run_id, position)
);

create index update_runs_active on update_runs (created_at desc)
    where state in ('planned', 'waiting_idle', 'running');
