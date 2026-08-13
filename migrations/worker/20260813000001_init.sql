-- The worker owns what actually happened. The control plane keeps a cache of
-- this that it can throw away and rebuild.
--
-- Portable SQL only: no engine-specific syntax, so moving the hosted control
-- plane to Postgres later is a connection string and a type audit, not a rewrite.

CREATE TABLE sessions (
    id          TEXT PRIMARY KEY,
    repo        TEXT NOT NULL,
    title       TEXT NOT NULL,
    prompt      TEXT NOT NULL,
    branch      TEXT NOT NULL,
    base        TEXT NOT NULL,
    agent       TEXT NOT NULL,
    status      TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE workspaces (
    session_id    TEXT PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
    path          TEXT NOT NULL,
    tmux_session  TEXT NOT NULL,
    created_at    TEXT NOT NULL
);

-- seq is the resume cursor: a reconnecting control plane asks for everything
-- after the last one it saw, and the browser carries it as an event id.
CREATE TABLE events (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    payload     TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

CREATE INDEX events_by_session ON events (session_id, seq);
