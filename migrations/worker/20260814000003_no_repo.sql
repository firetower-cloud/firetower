-- A bare agent: somewhere to work, nothing checked out. SQLite can't drop a
-- NOT NULL in place, so the table is rebuilt — it holds a cache of this
-- worker's own sessions, and the event log beside it is untouched.
CREATE TABLE sessions_new (
    id          TEXT PRIMARY KEY,
    repo        TEXT,
    title       TEXT NOT NULL,
    prompt      TEXT NOT NULL,
    branch      TEXT,
    base        TEXT,
    agent       TEXT NOT NULL,
    size        TEXT NOT NULL DEFAULT 'Medium',
    status      TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

INSERT INTO sessions_new
    SELECT id, repo, title, prompt, branch, base, agent, size, status, created_at, updated_at
    FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
