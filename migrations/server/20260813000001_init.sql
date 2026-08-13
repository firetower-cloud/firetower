-- The control plane owns what should happen: the fleet, the repositories, the
-- credentials, and the scheduling. Sessions and events are a *cache* of what the
-- workers reported — delete this file and it rebuilds on reconnect.
--
-- user_id is present from the first migration and is always 1 today. Adding a
-- tenant key to a live schema later is far more painful than carrying an unused
-- column now.

CREATE TABLE hosts (
    id              TEXT PRIMARY KEY,
    user_id         INTEGER NOT NULL DEFAULT 1,
    name            TEXT NOT NULL UNIQUE,
    -- NULL for the local host: there is nothing to connect to.
    ssh_target      TEXT,
    state           TEXT NOT NULL,
    cpus            INTEGER,
    memory_mb       INTEGER,
    worker_version  TEXT,
    last_seen_at    TEXT,
    -- how far we have consumed this worker's log; the resume cursor
    last_seq        INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL
);

CREATE TABLE repos (
    id              TEXT PRIMARY KEY,
    user_id         INTEGER NOT NULL DEFAULT 1,
    slug            TEXT NOT NULL UNIQUE,
    remote          TEXT NOT NULL,
    default_branch  TEXT NOT NULL,
    setup           TEXT,
    created_at      TEXT NOT NULL
);

CREATE TABLE sessions (
    id            TEXT PRIMARY KEY,
    user_id       INTEGER NOT NULL DEFAULT 1,
    host_id       TEXT NOT NULL REFERENCES hosts (id),
    repo          TEXT NOT NULL,
    title         TEXT NOT NULL,
    prompt        TEXT NOT NULL,
    branch        TEXT NOT NULL,
    base          TEXT NOT NULL,
    agent         TEXT NOT NULL,
    status        TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE INDEX sessions_by_status ON sessions (status, updated_at);

-- A local mirror of worker logs, so the interface can render history without
-- waiting on every host to answer.
CREATE TABLE events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id     TEXT NOT NULL REFERENCES hosts (id),
    seq         INTEGER NOT NULL,
    session_id  TEXT NOT NULL,
    payload     TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    UNIQUE (host_id, seq)
);

CREATE INDEX events_by_session ON events (session_id, id);

CREATE TABLE credentials (
    id          TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL DEFAULT 1,
    agent       TEXT NOT NULL UNIQUE,
    mode        TEXT NOT NULL,
    label       TEXT NOT NULL,
    -- a pointer into the OS keychain, never the secret itself
    secret_ref  TEXT NOT NULL,
    placement   TEXT NOT NULL,
    expires_at  TEXT,
    created_at  TEXT NOT NULL
);
