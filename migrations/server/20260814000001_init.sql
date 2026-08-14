-- The control plane owns what should happen: the fleet, the repositories, the
-- credentials, and the scheduling. Sessions and events are a *cache* of what
-- the workers reported — drop this database and it rebuilds on reconnect.
--
-- Written fresh for Postgres rather than translated, because the earlier
-- SQLite migrations described a schema nobody is running.
--
-- user_id is here from the first migration and is always 1 today. Adding a
-- tenant key to a live schema later is far more painful than carrying an
-- unused column now.

CREATE TABLE hosts (
    id              TEXT PRIMARY KEY,
    user_id         BIGINT      NOT NULL DEFAULT 1,
    name            TEXT        NOT NULL UNIQUE,
    -- NULL for the local host: there is nothing to connect to.
    ssh_target      TEXT,
    state           TEXT        NOT NULL,
    cpus            INTEGER,
    memory_mb       BIGINT,
    worker_version  TEXT,
    last_seen_at    TIMESTAMPTZ,
    -- how far we have consumed this worker's log; the resume cursor
    last_seq        BIGINT      NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE repos (
    id              TEXT PRIMARY KEY,
    user_id         BIGINT      NOT NULL DEFAULT 1,
    slug            TEXT        NOT NULL,
    -- The remote is what is unique, not the name: two hosts can both have an
    -- `acme/backend`, and they are different repositories.
    remote          TEXT        NOT NULL UNIQUE,
    default_branch  TEXT        NOT NULL,
    setup           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
    id            TEXT        PRIMARY KEY,
    user_id       BIGINT      NOT NULL DEFAULT 1,
    host_id       TEXT        NOT NULL REFERENCES hosts (id),
    repo          TEXT        NOT NULL,
    title         TEXT        NOT NULL,
    prompt        TEXT        NOT NULL,
    branch        TEXT        NOT NULL,
    base          TEXT        NOT NULL,
    agent         TEXT        NOT NULL,
    size          TEXT        NOT NULL DEFAULT 'Medium',
    status        TEXT        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX sessions_by_status ON sessions (status, updated_at);

-- A local mirror of worker logs, so the interface can render history without
-- waiting on every host to answer.
CREATE TABLE events (
    id          BIGSERIAL   PRIMARY KEY,
    host_id     TEXT        NOT NULL REFERENCES hosts (id),
    seq         BIGINT      NOT NULL,
    session_id  TEXT        NOT NULL,
    payload     JSONB       NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (host_id, seq)
);

CREATE INDEX events_by_session ON events (session_id, id);

-- How each agent authenticates. One row per kind, created on first configure.
--
-- `secret` holds the value as given, for now. Encrypting it is the next piece
-- of work and does not change the shape of this table.
CREATE TABLE agents (
    kind        TEXT        PRIMARY KEY,
    mode        TEXT        NOT NULL,
    enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
    secret      TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- What a host reported about an agent, last time we asked. A cache: losing it
-- costs one probe, and a host we cannot reach keeps showing what it last said.
CREATE TABLE agent_presence (
    host_id     TEXT        NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
    kind        TEXT        NOT NULL,
    installed   BOOLEAN     NOT NULL,
    version     TEXT,
    -- NULL where the agent offers no way to ask without starting it, which is
    -- not the same as being signed out.
    logged_in   BOOLEAN,
    account     TEXT,
    checked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (host_id, kind)
);

-- Which credentials exist, so asking "is one set?" never reads the value.
CREATE TABLE credentials (
    scope TEXT NOT NULL,
    name  TEXT NOT NULL,
    PRIMARY KEY (scope, name)
);
