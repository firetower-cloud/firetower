-- Why a session is waiting, as the agent put it.
--
-- Kept here as well as sent upstream so a hook can tell whether anything
-- changed. `PreToolUse` fires before every tool call and a blocked agent
-- notifies repeatedly while it waits — without something to compare against,
-- both write a row every time and the log fills with copies.
ALTER TABLE sessions ADD COLUMN note TEXT;
