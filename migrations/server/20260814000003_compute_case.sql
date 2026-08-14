-- Enum values on the wire are the symbol they are — `Local`, not `local`. The
-- previous migration wrote the lowercase form, which no longer decodes.
UPDATE hosts SET compute = jsonb_set(compute, '{type}', '"Local"')
WHERE compute->>'type' = 'local';

UPDATE hosts SET compute = jsonb_set(compute, '{type}', '"Server"')
WHERE compute->>'type' = 'server';

UPDATE hosts SET compute = jsonb_set(compute, '{type}', '"Container"')
WHERE compute->>'type' = 'container';
