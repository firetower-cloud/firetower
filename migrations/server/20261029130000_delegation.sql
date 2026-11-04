-- Whether a profile delegates.
--
-- The one distinction that matters, kept as one column rather than a graph. A
-- Manager gets the spawn tool and may hand work to any profile it can see —
-- which profile, for what, lives in its instructions, where a sentence says
-- what a curated list never could. An Operator does the work and reports back,
-- and is never given the tool.
--
-- Bounded already: a Manager can only reach the profiles its owner can, through
-- the same `access::filed_where` predicate everything else uses, so there is no
-- second access system to keep. Defaults false — a new profile is an Operator
-- until someone says otherwise.
alter table roles add column can_delegate boolean not null default false;

-- Which profile a session was started as, when it was started as one.
--
-- `set null`, not `cascade`: deleting a profile must not take the running
-- sessions with it — they keep going, they just stop being able to say which
-- kind they were. A null is a plain agent with no persona, which is what every
-- session was before "start as" existed.
alter table sessions add column profile_id text references roles(id) on delete set null;
