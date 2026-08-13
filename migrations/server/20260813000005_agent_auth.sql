-- Whether a host is signed in, and as whom.
--
-- Worth showing next to the version: an agent that is installed but signed out
-- will fail the moment a session starts, and knowing which account a host
-- spends against is the difference between two subscriptions on one machine.
--
-- Nullable on purpose. Not every agent can be asked without being started, and
-- "we don't know" is a real answer that must not read as "no".
ALTER TABLE agent_presence ADD COLUMN logged_in INTEGER;
ALTER TABLE agent_presence ADD COLUMN account TEXT;
