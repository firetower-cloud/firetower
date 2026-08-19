-- Something to call a session.
--
-- A repository and a title cut from the first four words of a prompt are not
-- enough to tell five sessions apart: same repository, same agent, same host,
-- and four titles beginning "Ask me". So every session gets a number and a
-- name, and the name is yours to change.
--
-- The number comes from a sequence and is never reused — not per repository,
-- not after a session ends. A number you wrote down last week must not come
-- back pointing at somebody else's work.
CREATE SEQUENCE session_number_seq;

ALTER TABLE sessions ADD COLUMN number BIGINT;
ALTER TABLE sessions ADD COLUMN name TEXT;

-- What is already here, oldest first, so the numbering matches the order they
-- happened in rather than the order the rows come back.
WITH ordered AS (
    SELECT id, row_number() OVER (ORDER BY created_at) AS n FROM sessions
)
UPDATE sessions s
   SET number = ordered.n,
       name = 'Agent ' || ordered.n
  FROM ordered
 WHERE s.id = ordered.id;

-- And the sequence carries on from there. The third argument is what keeps a
-- fresh install starting at 1: setval(seq, 1) alone means the next number
-- handed out is 2, so with nothing to carry on from, say the value has not
-- been used yet.
SELECT setval(
    'session_number_seq',
    GREATEST((SELECT COALESCE(MAX(number), 0) FROM sessions), 1),
    (SELECT count(*) > 0 FROM sessions)
);

ALTER TABLE sessions ALTER COLUMN number SET NOT NULL;
ALTER TABLE sessions ALTER COLUMN number SET DEFAULT nextval('session_number_seq');
ALTER TABLE sessions ADD CONSTRAINT sessions_number_key UNIQUE (number);
