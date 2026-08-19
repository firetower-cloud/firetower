-- Removing a session from here when the machine it runs on has gone.
--
-- Normally a session ends because the worker said so. When the host is not
-- answering there is nobody to ask, and until now the row stayed `Working`
-- forever — a ghost on the inbox for a machine that no longer exists.
--
-- `forgotten_at` records that you removed it here anyway. It is what keeps the
-- ghost from coming back: a `StatusChanged` replayed by a worker that turns up
-- later must not put a session you removed back on the inbox.
ALTER TABLE sessions ADD COLUMN forgotten_at TIMESTAMPTZ;

-- And what the machine was told, if it ever came back to be told.
--
-- Removing it here does not stop the agent over there. If that host reconnects,
-- the workspace and its tmux session are still torn down — late, but done — and
-- this is what stops us asking twice.
ALTER TABLE sessions ADD COLUMN cleaned_at TIMESTAMPTZ;
