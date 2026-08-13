-- How each agent authenticates. One row per kind, created on first configure.
--
-- No secret lives here: an API key goes to the system keychain, and a
-- subscription is the CLI's own business on the host it was logged in on.
-- This table records intent, not credentials.
CREATE TABLE agents (
    kind       TEXT PRIMARY KEY,
    mode       TEXT NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
);

-- What a host reported about an agent, last time we asked.
--
-- A cache like everything else here: losing it costs one probe, and a host we
-- can't currently reach keeps showing what it last said rather than vanishing.
CREATE TABLE agent_presence (
    host_id    TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    installed  INTEGER NOT NULL,
    version    TEXT,
    checked_at TEXT NOT NULL,
    PRIMARY KEY (host_id, kind)
);
