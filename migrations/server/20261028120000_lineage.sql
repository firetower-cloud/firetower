-- Which session asked for this one.
--
-- Until now every session was a root: a person started it, and nothing in the
-- schema could say otherwise. A session that another session asked for — a
-- lead delegating part of its task to a child workspace — needs one edge, and
-- this is it. Everything the tree is for hangs off that edge: a child's
-- hand-back going to its lead rather than into the person's inbox, ending a
-- lead ending its children, counting how many a lead has started.
--
-- **Nullable, and null for every row that exists.** Every session created
-- before this was started by a person, which is exactly what null means.
-- Nothing is backfilled because there is nothing to backfill from.
--
-- `on delete set null` rather than cascade: a child that was started on its
-- own branch is work somebody may still want to ship, and losing it because
-- the lead's row went would delete a branch's only record. The reclaim sweep
-- decides what to do about an orphan; the foreign key does not.
--
-- `spawn_req` is the agent's own id for the call that asked. A worker that
-- reconnects re-announces every question its agent is still blocked on, so
-- the same spawn can arrive twice; the id is what lets the second arrival be
-- answered with the child the first one made, rather than with a second
-- child. Unique per lead, which is the whole of the idempotency.
alter table sessions
    add column parent_id    text references sessions(id) on delete set null,
    add column spawn_reason text,
    add column spawn_req    text;

create index sessions_by_parent on sessions (parent_id) where parent_id is not null;
create unique index sessions_spawn_req on sessions (parent_id, spawn_req)
    where parent_id is not null and spawn_req is not null;

comment on column sessions.parent_id is
  'The session that asked for this one, when one did. Null for everything a person started.';
comment on column sessions.spawn_reason is
  'What the lead said this child was for, in its own words. Shown on the child, kept for the record.';
comment on column sessions.spawn_req is
  'The lead''s tool-call id for the spawn that made this. Lets a repeated request find the child it already has.';

-- What a child handed back while its lead was mid-turn.
--
-- A result is delivered to the lead as a turn, between its turns, never into
-- one. When the lead is Working the result waits here; the moment the lead
-- stops, whatever is waiting is sent. Rows are kept after delivery for the
-- same reason events are: the record of what a lead was told, and when, is
-- the record of why it did what it did next.
create table deliveries (
    id           text primary key,
    to_session   text not null references sessions(id) on delete cascade,
    from_session text references sessions(id) on delete set null,
    -- The text the lead receives, composed when the child handed back.
    body         text not null,
    created_at   timestamptz not null default now(),
    delivered_at timestamptz
);

create index deliveries_waiting on deliveries (to_session) where delivered_at is null;

comment on table deliveries is
  'Results from child sessions, waiting for their lead to be between turns.';
