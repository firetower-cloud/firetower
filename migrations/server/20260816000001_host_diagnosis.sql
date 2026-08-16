-- Why a host isn't answering, kept on the host.
--
-- `Unreachable` says something is wrong and nothing about what, and a failed
-- connection otherwise leaves only a log line nobody is watching.
--
-- JSON rather than columns: it is read as a whole and never queried by its
-- parts. NULL means the host is answering, and connecting clears it.
ALTER TABLE hosts ADD COLUMN diagnosis JSONB;

-- The container a server's worker runs in lives inside `compute`, with the rest
-- of what it takes to reach a machine. No backfill: absent and "no container"
-- mean the same thing, which is what existing rows have been doing.
