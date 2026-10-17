-- Opt-out telemetry: what this install is waiting to tell us, and whether it
-- has.
--
-- ## Why anything is stored at all
--
-- The control plane is a server that does not call out. It computes one digest
-- per completed UTC day into this table, and a desktop app collects it and
-- posts it on. So the row is the outbox: it exists because the thing that knows
-- the numbers and the thing that can reach the internet are different
-- machines.
--
-- That shape is also what makes the counting correct. A digest is computed
-- once, and whichever client gets to it first marks it delivered — so twelve
-- teammates with the app open deliver one digest between them rather than
-- twelve copies of the same day.
--
-- ## One row per day, keyed by the day
--
-- `day` is the primary key, not a serial with a day column, because a second
-- row for a day is never right: it would either be a duplicate of a day
-- already reported or a disagreement about what that day was. Recomputing a
-- day — which happens when a release adds a metric and backfills — replaces.
--
-- A `date` rather than a timestamp. The grain is the unit of meaning here, and
-- a timestamp invites somebody to store midnight in whichever zone the writer
-- happened to be in.
--
-- ## What is deliberately absent
--
-- No reference to `organizations`. One install is one organisation — the
-- `installation` singleton says which — so an org id on every row would be the
-- same value repeated, and a cascade from it would delete the record of what
-- was already reported.
--
-- Nothing per person, here or in the payload. See `crate::telemetry`.
create table telemetry_digests (
    day          date not null primary key,

    -- The digest exactly as it will be sent, built once and sent verbatim.
    --
    -- Stored assembled rather than as columns to be assembled on the way out,
    -- for one reason that matters: it is what makes `GET /telemetry/preview`
    -- honest. An administrator reads this and has read the bytes that leave,
    -- not a rendering of them that some later code path might disagree with.
    payload      jsonb not null,

    computed_at  timestamptz not null default now(),

    -- When a client confirmed the gateway had it. Null while it is still owed.
    --
    -- The ack is what stops a second client sending the same day. It is set
    -- after the post succeeds rather than before, so a failed send is retried
    -- and a lost ack costs one harmless replay — the gateway's primary key is
    -- `(install_id, day)`, so arriving twice is an upsert and not a double
    -- count.
    delivered_at timestamptz
);

-- "What is still owed", which is the only question any client asks. Partial,
-- because an install that has been running for a year has one row in it.
create index telemetry_digests_undelivered
    on telemetry_digests (day)
    where delivered_at is null;

comment on table telemetry_digests is
  'Daily telemetry digests awaiting collection by a client. Counts only, never records about people.';
comment on column telemetry_digests.payload is
  'The bytes that will be sent. What /telemetry/preview shows.';
