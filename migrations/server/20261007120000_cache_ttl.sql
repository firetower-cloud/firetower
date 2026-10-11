-- The two kinds of cache write, which are not the same price.
--
-- `cache_write_tokens` collapsed them, and they are the distinction that
-- decides what a turn costs: a one-hour entry is billed at roughly twice an
-- input token and a five-minute one at roughly a quarter more. A page that says
-- "80% read from cache" is describing volume; this is what lets it describe
-- money.
--
-- ── Why these can be NULL, and why that is not a gap ────────────────────
--
-- The agent reports the split in its per-turn `usage.cache_creation` block and
-- *not* in `modelUsage`. Our grain is one row per turn per model, which is
-- finer than the split is measured at, so where several models wrote cache in
-- one turn the figure here is apportioned between them by their share of the
-- write — exact whenever one model did all of it, which is the ordinary case,
-- and a stated estimate otherwise.
--
-- NULL means the agent said nothing. Codex reports no TTL at all, and an older
-- Claude Code may not either; zero would claim the turn wrote nothing to cache
-- for an hour, which is a different and possibly false statement.
alter table consumption_events
  add column cache_write_1h_tokens bigint,
  add column cache_write_5m_tokens bigint;

comment on column consumption_events.cache_write_1h_tokens is
  'Cache written with a one-hour life, the expensive kind. NULL when unreported; apportioned when a turn used several models.';
comment on column consumption_events.cache_write_5m_tokens is
  'Cache written with a five-minute life. NULL when unreported.';
