-- A host is one of three kinds of place an agent can run, not a machine that
-- either has an ssh target or doesn't.
--
-- Stored as a tagged value rather than a column per variant: `image` and
-- `name` only mean anything for a container, `target` only for a server, and
-- five mostly-NULL columns describe the shape worse than one that says what it
-- is. Postgres can still be asked `compute->>'type'`.
ALTER TABLE hosts ADD COLUMN compute JSONB;

UPDATE hosts SET compute = CASE
    WHEN ssh_target IS NULL THEN '{"type":"local"}'::jsonb
    ELSE jsonb_build_object('type', 'server', 'target', ssh_target, 'hostKey', NULL)
END;

ALTER TABLE hosts ALTER COLUMN compute SET NOT NULL;
ALTER TABLE hosts DROP COLUMN ssh_target;

-- Draining is a state a host is put into, not a kind it is.
ALTER TABLE hosts ADD COLUMN drained BOOLEAN NOT NULL DEFAULT FALSE;
