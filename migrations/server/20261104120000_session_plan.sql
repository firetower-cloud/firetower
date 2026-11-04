-- The plan an agent keeps, when it sets one through `firetower:plan`.
--
-- Claude Code's todo list and Codex's own plan are already captured off the
-- turn stream and arrive live; this is the cross-engine fallback, for an agent
-- whose engine has no plan tool of its own. Stored on the session because that
-- is what the Overview rail already reads, and because a plan is a fact about
-- the agent rather than about any one turn.
alter table sessions add column plan jsonb;
