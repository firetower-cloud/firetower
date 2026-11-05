-- The system prompt a session started as a profile is working from.
--
-- A copy, not a reference: `profile_id` already says which profile, and the
-- two drift the moment somebody edits it. What the interface has to be able to
-- show — and what explains a run's behaviour to the person reading it — is the
-- text the agent was actually handed, composed when it launched.
--
-- Null for the ordinary case, which is a session that is no profile at all.
alter table sessions add column persona text;
