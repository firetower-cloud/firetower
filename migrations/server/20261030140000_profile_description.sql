-- Fold "when to use it" into the one description a lead reads.
--
-- A profile used to carry three separate lines — what it does, when to reach
-- for it, when not to. That is not how the ecosystem routes work: a skill and a
-- subagent each have one `description` that says what it is AND when to use it,
-- and that single line is the signal the model reads to decide. Three boxes
-- only invited blanks and filler, and nothing downstream ever read the extra
-- two. So `does` becomes that one description, and these go.
--
-- No backfill: the columns were unused — never rendered into any prompt — so
-- there is nothing in them worth folding into `does`.
alter table roles drop column use_when;
alter table roles drop column not_when;
