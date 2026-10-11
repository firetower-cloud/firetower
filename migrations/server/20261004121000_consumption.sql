-- What each turn cost, kept after everything that produced it is gone.
--
-- The numbers already existed: `ft_core::turn::Usage` is parsed out of every
-- agent's `result` line, carries a per-model breakdown, and reaches the control
-- plane on `TurnCompleted`. Nothing read it. The only place those figures
-- survived was `agent_lines`, the verbatim log — which is exactly what
-- `reclaim.rs` exists to delete, because one measured session of it was 9.3 MB.
-- So this is not new measurement. It is the measurement being written down
-- somewhere small enough to keep.

-- ── The tracker that produced a key, stated rather than parsed ──────────
--
-- `task_key` is source-scoped ("github:acme/web#5138"), so the tracker could be
-- read off the front of it. It is stored instead, for the reason the column
-- beside it already gives for the URL: "reconstructing somebody else's URL
-- scheme is a guess that breaks quietly when they change it." Splitting on a
-- colon is the same guess. Whoever adds the next tracker states its source id
-- once, here, and every reader gets it for free.
alter table workspaces add column task_provider text;

comment on column workspaces.task_provider is
  'Which tracker produced task_key — github, linear, whatever comes next.';

update workspaces
   set task_provider = split_part(task_key, ':', 1)
 where task_key is not null
   and position(':' in task_key) > 0;

-- ── What a task is called ───────────────────────────────────────────────
--
-- A separate table because the title is not ours and is not known when a turn
-- ends. `workspaces` keeps the key and the URL and nothing else, deliberately:
-- "the title, who it is assigned to, whether it is still open — is read from
-- the tracker on view, because it is somebody else's source of truth". So at
-- the moment consumption is written there is no title to copy, and a column on
-- the fact row would be NULL on every row of a task nobody had opened yet.
--
-- Instead this is filled opportunistically: every time a session view succeeds
-- in reading its issue, the title it got is remembered here. One row per task
-- ever seen, a few dozen bytes, never purged — so it is still here long after
-- the workspaces are gone, and a row written before the title was known picks
-- it up anyway.
--
-- Rows that never get a title are the honest case, not a bug. A revoked token,
-- a disconnected repository or a deleted issue leaves the key, which is what
-- the branch was actually cut for, and the interface draws that rather than
-- pretending.
create table consumption_tasks (
    org_id   text not null references organizations(id) on delete cascade,
    task_key text not null,
    url      text,
    title    text,
    -- When the title was last read from the tracker. NULL while it never has
    -- been, which is a different thing from a task with an empty title.
    title_at timestamptz,
    seen_at  timestamptz not null default now(),
    primary key (org_id, task_key)
);

comment on table consumption_tasks is
  'Titles read from a tracker and kept, so spend by task is still readable once the tracker is not.';

-- ── What each turn cost ─────────────────────────────────────────────────
--
-- Why nothing here references anything:
--
-- A workspace is reclaimed within the minute of its last session ending, and
-- its sessions, events and transcript go with it. A consumption row that
-- pointed at `sessions(id)` would be deleted by that cascade, which is the one
-- thing it must not do: the question this table answers — "what did that
-- feature cost me" — is asked *after* the work is finished and the worktree is
-- gone.
--
-- `owed_teardowns` already took this shape, and says why in its own comment:
-- "deliberately free of any reference to `sessions` — outliving that row is the
-- whole point of it." Same here, for the same reason.
--
-- So every name is copied in at write time rather than joined at read time. A
-- workspace id with no workspace left is not something you can draw;
-- `agent/usage-tracking` is. Three things are referenced rather than copied,
-- because they outlive the data: `organizations`, `principals` — never deleted,
-- so a person who leaves keeps their name — and `consumption_tasks` above.
--
-- Grain is one row per turn per model. A turn is rarely one model: something
-- small names things and summarises alongside the one doing the work, and it is
-- on the bill. Rolling that up is a query; taking it apart again is impossible.
-- The key is `(session_id, turn_id, model)`, which makes the write idempotent —
-- a line replayed after a reconnect lands on the same row rather than billing
-- it twice.
--
-- `context_used` is deliberately absent. It is the right number for "how full
-- is the context" and the wrong one for anything here: `modelUsage` accumulates
-- across every request in a turn, so a cached prefix re-read on twenty tool
-- calls counts twenty times. Those totals are what the bill is made of. Summed
-- as context they would report several times the window. See `normalise.rs`.
--
-- There is no rollup table and does not need to be one. These are text-light
-- facts at roughly 800 bytes; a 200-seat installation writes about 435 MB a
-- year, against 9.3 MB for a single session's transcript. The only summary that
-- compresses usefully — one row per day per model — cannot answer a single
-- question the page asks.
create table consumption_events (
    org_id      text        not null references organizations(id) on delete cascade,
    occurred_at timestamptz not null,

    -- Where this was filed, and who may therefore read it.
    --
    -- A copy rather than a join: `workspaces.path` goes when the workspace
    -- does, and a directory can be deleted once nothing is filed in it. Both
    -- columns are what `access.rs::filed_where` asks for — the only place "may
    -- see this" is written down — so a reader of this table builds its
    -- predicate from the same function as every other reader.
    --
    -- Being a copy makes it a snapshot: moving a workspace into another
    -- directory does not move the spend it already made. That is deliberate.
    -- History that rewrites itself when somebody tidies up is worse than
    -- history that is plainly as-at.
    path        ltree not null,
    extra_perms jsonb not null default '{}',

    -- Who ran the turn. Not who cut the worktree: `workspaces.created_by` is a
    -- different fact, and several people's sessions can live in one workspace.
    ran_as text references principals(id),

    -- ── What ran. No references; these outlive their subjects. ──────────
    workspace_id   text not null,
    workspace_name text,
    session_id     text not null,
    session_title  text,
    turn_id        text not null,

    -- ── What it was for ─────────────────────────────────────────────────
    --
    -- The key is kept on the row rather than only in `consumption_tasks` so
    -- that grouping by task needs no join and a row with no title is still
    -- renderable. The provider is kept so "only GitHub" is an indexed filter
    -- rather than a string split on every row.
    task_key      text,
    task_provider text,
    repo_remote   text,
    branch        text,

    -- ── Which engine, billed to whose subscription ──────────────────────
    --
    -- The account is captured per turn, not derived from the session: a session
    -- can change accounts while it runs — that is what `agent_account_switches`
    -- is — and a switched session would otherwise attribute its whole spend to
    -- whichever account it happened to finish on.
    agent        text not null,
    account_id   text,
    account_name text,
    model        text not null,

    -- ── The numbers ─────────────────────────────────────────────────────
    --
    -- Cache reads and writes are apart because they cost different amounts and
    -- mean different things: reading is the session being cheap, writing is it
    -- having said something new and large.
    input_tokens       bigint not null default 0,
    output_tokens      bigint not null default 0,
    cache_read_tokens  bigint not null default 0,
    cache_write_tokens bigint not null default 0,
    thinking_tokens    bigint,

    -- The agent's own arithmetic, in dollars, where it does any.
    --
    -- NULL is not zero. Codex reports no price at all, so a total over a mixed
    -- fleet is partial by construction and anything showing one has to say so —
    -- count the rows where this is set rather than assuming they all are. Even
    -- where present it is an API-equivalent figure and not what a subscription
    -- was billed, which is why the interface calls it an estimate.
    cost_usd    numeric(14,6),
    duration_ms bigint,

    primary key (session_id, turn_id, model)
);

-- The page's two shapes: a period for an organisation, and everything filed
-- against one task across however many workspaces were cut for it.
create index consumption_by_time on consumption_events (org_id, occurred_at desc);
create index consumption_by_task on consumption_events (org_id, task_key, occurred_at desc)
    where task_key is not null;

-- `filed_where` asks `path <@ 'u.someone'` and `path <@ 'd.something'`, which is
-- containment and wants GiST rather than the default btree.
create index consumption_by_path on consumption_events using gist (path);

comment on table consumption_events is
  'What each turn cost, per model. Outlives the workspace that produced it.';
comment on column consumption_events.path is
  'Where this was filed when it ran. A snapshot: moving a workspace does not move its history.';
comment on column consumption_events.cost_usd is
  'The agent''s own estimate in dollars, where it reports one. NULL means not reported, not zero.';
