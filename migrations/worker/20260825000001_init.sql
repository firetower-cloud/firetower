-- What a worker remembers, as one schema.
--
-- This replaces six incremental migrations, one of which rebuilt the sessions
-- table to make three columns nullable and another of which copied every row
-- into `session_repos`. Both were about a session growing from one repository
-- to several; neither is worth carrying, because no worker has state anybody
-- has to keep.
--
-- The worker's own record, not a copy of the control plane's. It holds what it
-- needs to answer a reconnect — which sessions exist here, where their
-- workspaces are, and what it has already said — and nothing about accounts:
-- who a session belongs to is the control plane's business, and a worker that
-- knew would be a worker that could be asked.

CREATE TABLE sessions (
    id          TEXT PRIMARY KEY,
    repo        TEXT,
    title       TEXT NOT NULL,
    prompt      TEXT NOT NULL,
    branch      TEXT,
    base        TEXT,
    agent       TEXT NOT NULL,
    size        TEXT NOT NULL DEFAULT 'Medium',
    status      TEXT NOT NULL,
    note        TEXT,
    -- Which note is the latest, so a reconnect replays them in order.
    note_rank   INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

-- One checkout per repository a session holds, in the order they were asked
-- for. `path` is relative to the workspace, and empty means the checkout is
-- the workspace itself.
CREATE TABLE session_repos (
    session_id  TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    slug        TEXT NOT NULL,
    remote      TEXT NOT NULL,
    base        TEXT NOT NULL,
    branch      TEXT NOT NULL,
    path        TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (session_id, position)
);

CREATE TABLE workspaces (
    session_id    TEXT PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
    path          TEXT NOT NULL,
    tmux_session  TEXT NOT NULL,
    created_at    TEXT NOT NULL
);

-- Monotonic per worker, and the cursor a reconnecting control plane resumes
-- from.
CREATE TABLE events (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    payload     TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

CREATE INDEX events_by_session ON events (session_id, seq);
