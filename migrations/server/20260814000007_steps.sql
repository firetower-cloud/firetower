-- What a session is going to do, decided when it is created.
--
-- Stored rather than derived so the screen can show the whole list before the
-- worker has said anything at all — which is the entire point. A session that
-- spends eight minutes fetching a repository should look like it is fetching a
-- repository, not like nothing is happening.
ALTER TABLE sessions ADD COLUMN steps JSONB NOT NULL DEFAULT '[]'::jsonb;
