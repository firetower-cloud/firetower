# Workspace teardown must reclaim its data

**Status:** planned, not built. Written for handoff.

## The problem

Nothing on the session path is ever deleted. `forget_session` and `mark_cleaned`
set `workspaces.forgotten_at` and `workspaces.cleaned_at`, and both are facts
*about the directory on the host* — the worktree goes, the rows stay. There is
no pruning job, no retention policy, and no expiry anywhere in the control
plane. A self-hosted customer's Postgres grows without bound for as long as they
use the product.

The weight is almost entirely one table. `agent_lines` holds the agent's raw
stream-json log verbatim, one row per line, and the normaliser re-folds all of
it on every conversation read. Because it is the raw log, the base64 of every
screenshot an agent captured is sitting inside `line` as text.

Measured on one real session: 9.3 MB of log, 2.3 MB of it image payload across
10 images, largest single image 673 KB of base64.

There is one real delete path today — `DELETE FROM hosts` (`db.rs:270`) —
which cascades through `sessions.host_id` into `agent_lines`. So the cascades
below are not theoretical; they already run when a host is removed.

## Decisions taken

| | |
|---|---|
| **Trigger** | two modes — see below |
| **Timing** | immediate. No grace period |
| **Scope** | everything. Delete the `workspaces` row and let the cascade take the rest, including the `sessions` rows |
| **Retention** | out of scope; a later feature |

Ended sessions are currently listed forever — `sessions_page` (`db.rs:1022`)
filters on neither `status` nor `forgotten_at`, so a user's history contains
every session they have ever run. Wiping the row means that history goes too.
That is accepted for now. If "what did I ship last month" is wanted later, it
wants a small summary table (title, branch, PR url, timestamps), not retained
`agent_lines`.

### The two teardown modes

1. **Safe** — the worker confirmed the worktree is gone (`cleaned_at` is set).
   Purge follows immediately.
2. **Force end workspace** — new feature. For a host nobody can reach any more,
   where the operator has removed the machine by hand. Purges the DB rows
   without waiting for a worker to confirm anything.

## Two landmines to clear first

Both are in the schema today and both will bite the purge.

### `agent_account_switches.next_session_id` will block deletes

```sql
next_session_id text references sessions(id)   -- no ON DELETE clause
```

Defaults to `NO ACTION`. Deleting a session that some switch points at as
`next_session_id` fails with a foreign key violation. This is already a latent
bug on the host-removal path — removing a host can fail today for this reason.
Must become `ON DELETE SET NULL`.

### `events.session_id` has no foreign key at all

```sql
create table events (
    ...
    session_id  text not null,   -- no REFERENCES
);
```

`events.host_id → hosts(id) on delete cascade` covers worker-sent events, but
the `local_events` migration made `host_id` nullable so the control plane could
raise its own. Those rows have `host_id IS NULL` and **nothing deletes them,
ever**. When a host is removed its sessions cascade away and those events are
orphaned permanently. Needs `ON DELETE CASCADE` on `session_id`, which means
clearing the existing orphans first.

### What is already covered

Cascades correctly from `sessions`: `agent_lines`, `session_repos`,
`session_controls`, `preview_annotations`, `agent_presence`,
`agent_account_switches.session_id`.

Cascades correctly from `workspaces`: `sessions.workspace_id`,
`workspace_repos.workspace_id`.

So once the two landmines are fixed, `DELETE FROM workspaces WHERE id = $1`
removes everything.

## Work items

### W1 — Migration: fix the foreign keys

- `agent_account_switches.next_session_id` → `ON DELETE SET NULL`.
- `events.session_id` → `ON DELETE CASCADE`. Add it `NOT VALID` first, then
  `VALIDATE CONSTRAINT` separately, so the table is not held under an exclusive
  lock while every existing row is checked.
- Ordering matters: the orphan clear-out in W2 has to happen before the
  constraint can validate.

### W2 — Backfill the existing mess

Three deletes, all batched:

1. `events` with no matching session.
2. Everything belonging to workspaces where `cleaned_at IS NOT NULL`.
3. Everything belonging to workspaces where `forgotten_at IS NOT NULL` — the
   directory is gone or owed a teardown; either way the data is dead. See the
   note on teardown debt below before running this one.

**Batch it.** A single unbounded `DELETE` takes a long lock and generates WAL
proportional to everything it touches. Loop
`DELETE ... WHERE ctid IN (SELECT ctid ... LIMIT 10000)` until zero rows
affected. Consider running the bulk as an idempotent one-shot command rather
than inside the migration, so a slow delete cannot block a deploy.

**Follow with `VACUUM (ANALYZE)`.** Deleting rows does not return disk to the
operating system. Whoever runs this needs to be told, or they will delete tens
of gigabytes, watch disk usage not move, and conclude it failed. If the table is
badly bloated, `pg_repack` is the tool that actually shrinks it.

**Dry run first.** The queries in "Measuring it" below give the row counts and
byte estimates without touching anything. Run them on a restored production
snapshot, time the deletes there, and only then schedule the real one.

### W3 — Purge on teardown

Because the purge is immediate and the cascade does the work, this is not a
scheduled job. It is a `DELETE FROM workspaces WHERE id = $1` called from the
two places teardown completes:

- `mark_cleaned` — the safe path.
- the new force-end endpoint.

Plus one backstop sweep at start-up for workspaces that were cleaned while the
control plane was down. Model it on `updates::status::watch` (`updates/status.rs:58`),
which is the existing periodic-task pattern: sleep, do the thing, log, repeat.

There is no existing purge job to extend. `Accounts::sweep_sessions`
(`accounts.rs:587`) deletes expired *login tokens* from `user_sessions` despite
the name, and is never called outside a test.

### W4 — Force end workspace

New endpoint plus the UI affordance. The careful part is teardown debt.

`owed_cleanup_on` finds work with
`forgotten_at IS NOT NULL AND cleaned_at IS NULL` and re-sends teardown when a
host reconnects. If force-delete removes the workspace row, that debt is
forgotten with it — and a host that comes back later keeps a live worktree and
possibly a running agent, forever.

So force mode needs a tombstone that outlives the purge:

```sql
create table orphaned_worktrees (
    host_id      text not null,
    path         text not null,
    forgotten_at timestamptz not null default now(),
    primary key (host_id, path)
);
```

Written before the workspace row is deleted, consumed by the reconnect path,
deleted once the host confirms. This is the difference between "force delete"
and "leak a container on a machine you have lost track of".

### W5 — Tests

- A cleaned workspace loses everything: lines, events, annotations, repos,
  controls, presence.
- **A live workspace is untouched.** The one that matters most.
- Host removal succeeds when an `agent_account_switches.next_session_id` points
  at a session being deleted — the regression for landmine 1.
- No orphan `events` survive a session delete — the regression for landmine 2.
- Purge is idempotent; a second run deletes nothing and does not error.
- Force-end writes an `orphaned_worktrees` row, and a reconnecting host is still
  told to tear the directory down.

## Rollout order

1. W1 (FK fixes) — small, safe, ships alone.
2. W2 on a **restored production snapshot first**, timed and measured. Then for
   real, off-peak, followed by `VACUUM`/`pg_repack`.
3. W3 + W4 together.

## Measuring it

Read-only. Run before and after.

```sql
-- Where the bytes are
SELECT c.relname, pg_size_pretty(pg_total_relation_size(c.oid)) AS total
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
 ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 12;

-- True orphans: events whose session is already gone
SELECT count(*) AS orphan_events,
       pg_size_pretty(COALESCE(sum(pg_column_size(payload)), 0)::bigint) AS bytes
  FROM events e LEFT JOIN sessions s ON s.id = e.session_id
 WHERE s.id IS NULL;

-- Dead weight: transcripts whose workspace is already torn down
SELECT count(*) AS lines,
       pg_size_pretty(COALESCE(sum(pg_column_size(line)), 0)::bigint) AS stored
  FROM agent_lines al
  JOIN sessions   s ON s.id = al.session_id
  JOIN workspaces w ON w.id = s.workspace_id
 WHERE w.cleaned_at IS NOT NULL;

-- How much of the transcript is image payload (1% sample; extrapolate x100)
SELECT count(*) FILTER (WHERE line LIKE '%"type":"image"%') AS image_lines,
       pg_size_pretty(COALESCE(sum(pg_column_size(line))
              FILTER (WHERE line LIKE '%"type":"image"%'), 0)::bigint) AS image_stored,
       pg_size_pretty(COALESCE(sum(octet_length(line))
              FILTER (WHERE line LIKE '%"type":"image"%'), 0)::bigint) AS image_raw,
       pg_size_pretty(COALESCE(sum(pg_column_size(line)), 0)::bigint) AS sampled_total
  FROM agent_lines TABLESAMPLE SYSTEM (1);
```

`pg_column_size` is the stored size; base64 in TOAST compresses well, often to
65–75% of raw. `octet_length` is the uncompressed number. Both are in the last
query so the gap is visible — on-disk will be smaller than the raw figures
suggest, but it is unbounded either way.

## Relationship to the image work

Orthogonal, and this is the more urgent of the two. Serving images by reference
instead of inlining base64 reduces what crosses the wire; it does not reduce the
table. Only this plan does.

They meet in one place: once transcripts can be purged, an image reference can
dangle. The image endpoint must answer "no longer available" cleanly rather than
500 — which is also the honest answer for a transcript whose bytes were
reclaimed.
