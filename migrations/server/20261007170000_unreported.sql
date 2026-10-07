-- A turn whose agent never said what it cost.
--
-- Until now these were not written at all, which made them invisible rather
-- than unknown: a Kimi session ran, finished, was reclaimed, and the usage page
-- showed no trace it had ever happened. "Nothing here" and "we were not told"
-- are different answers and the second one is the true one.
--
-- They cannot be told apart by the token columns, which are `not null default
-- 0`, and a zero there is a claim — it says the turn was free. So the claim is
-- moved to its own column and the zeros stop meaning anything on these rows.
--
-- Why not make the token columns nullable instead, in the way `cost_usd`
-- already is? Because every reader sums them. `SUM` skips NULL and so does
-- `COALESCE(...,0)`, which means a nullable column would read identically to a
-- zero in every query the page runs, and the distinction would be lost exactly
-- where it matters. A boolean beside them is one more thing to select and
-- impossible to sum by accident.
--
-- `true` by default because every row already here was written from figures an
-- agent reported. Claude Code and Codex both do; ACP agents are the ones that
-- do not, and today that is all of them — Kimi's own source says it, where it
-- resolves a finished prompt with a stop reason and nothing else and notes
-- beside its context gauge that "the engine has no cost data".
alter table consumption_events
  add column tokens_known boolean not null default true;

comment on column consumption_events.tokens_known is
  'False where the agent reported no token counts. The zeros beside it are placeholders, not measurements.';

-- The page asks "how much of this period is unaccounted for", which is a
-- count over a filter rather than a lookup, and on a period that is almost
-- entirely reported it reads very few rows.
create index consumption_unreported on consumption_events (org_id, occurred_at desc)
    where not tokens_known;
