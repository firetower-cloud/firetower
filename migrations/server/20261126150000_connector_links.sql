-- Where an application is made, and how — said by the entry, not by us.
--
-- These were a hardcoded match on thirteen hostname substrings compiled into
-- the control plane: `h.contains("google")`, `h.contains("figma")`. Three
-- things were wrong with that. A catalogue nobody here wrote had no way to
-- say where its own console is, so adding one meant a pull request against
-- Firetower. A substring match is loose in a way that is wrong exactly once.
-- And the product was carrying a directory of other people's URLs, which is
-- the marketplace's whole job.
--
-- Nullable, and no fallback behind them: a server we were not told about
-- shows no link rather than a guess.
alter table connectors add column console text;
alter table connectors add column guide   text;
