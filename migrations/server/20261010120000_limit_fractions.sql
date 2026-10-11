-- A quota that is 1.5% used should not be drawn as 1%.
--
-- The column was `smallint`, so every provider's figure was rounded to a whole
-- per cent on the way in and the rest was gone for good. That is fine for a
-- meter and wrong for a number somebody is watching: at the start of a monthly
-- cycle, 1% against 1.5% is the difference between a quiet month and twice the
-- burn rate, and those are the only digits moving.
--
-- The precision already exists at the source and was being thrown away. Kimi
-- reports a ratio — `used_ratio: 0.014` — so widening costs nothing and keeps
-- what it already said. Codex reports whole per cent and is unaffected; Claude
-- reports no percentage at all.
--
-- Why not integer hundredths, the way money is kept in cents? Because the
-- reason cents exist is arithmetic: money is added, split and totalled, and
-- float drift accumulates until somebody is off by a penny. Nothing adds these
-- up. They are stored as a provider last said them and drawn as a bar. So a
-- scaled integer would buy exactness nobody spends, and charge for it at every
-- boundary — a `used_percent` of 150 meaning 1.5% is a column, an API field and
-- four clients that all have to remember the scale, and one that forgets ships
-- a number a hundred times wrong. `numeric(4,1)` says 1.5 and means it.
--
-- One decimal and no more. Two would be false precision on a figure the
-- provider recomputes on its own schedule, and the interface has nowhere to
-- put it.
alter table agent_account_limits
  alter column used_percent type numeric(4,1);

comment on column agent_account_limits.used_percent is
  'How much of the window is gone, to a tenth of a per cent. NULL where the provider does not say.';
