-- Who is allowed in, and who they are.
--
-- Until now the control plane knew only that somebody held a token. That
-- answers "may this request proceed" and nothing else — not who did it, not
-- whose organisation it belongs to, and not how to take one person's access
-- away without taking everyone's.
--
-- One organisation and one user today. The shape is the point: adding the
-- second of either is then rows, not a redesign.
--
-- Note on `user_id` in the first migration: `hosts`, `repos` and `sessions`
-- carry a `BIGINT user_id DEFAULT 1` placed there before this table existed,
-- and it is still always 1. It is deliberately not wired up here — converting
-- three tables to reference a TEXT id, and backfilling them, belongs with the
-- work that makes a second user real rather than with the work that makes the
-- first one exist.

CREATE TABLE organizations (
    id          TEXT        PRIMARY KEY,
    name        TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id                    TEXT        PRIMARY KEY,
    org_id                TEXT        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    username              TEXT        NOT NULL,
    -- argon2id, in PHC form: `$argon2id$v=19$m=…,t=…,p=…$<salt>$<hash>`.
    --
    -- The salt is 16 random bytes per password, and the cost parameters are in
    -- there too — which is what lets those be raised later while every
    -- existing password still verifies with the parameters it was made under.
    -- A separate salt column would store half of that and leave the rest
    -- implicit.
    password_hash         TEXT        NOT NULL,
    -- 'admin' is the only one today. The column exists so that the second role
    -- is a value rather than a migration.
    role                  TEXT        NOT NULL DEFAULT 'admin',
    -- Set when the password came from the environment rather than from a
    -- person. Until it clears, the only thing this account can do is replace
    -- it.
    must_change_password  BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Unique within an organisation rather than globally: a second
    -- organisation should be able to have its own `admin` without anyone
    -- having to rename theirs.
    UNIQUE (org_id, username)
);

-- A signed-in browser.
--
-- Rows rather than self-contained tokens, because signing out has to actually
-- end access. A token that carries its own claims cannot be withdrawn before
-- it expires, and "sign me out everywhere" is exactly the thing a password
-- change has to be able to do.
CREATE TABLE user_sessions (
    -- SHA-256 of the token, never the token. Anyone holding the value is the
    -- user, so what is stored is what lets us *compare* rather than what lets
    -- us *use* — the same argument the vault makes.
    token_hash    TEXT        PRIMARY KEY,
    user_id       TEXT        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ NOT NULL
);

CREATE INDEX user_sessions_by_user ON user_sessions (user_id);
CREATE INDEX user_sessions_by_expiry ON user_sessions (expires_at);

-- One row, ever, and the database is what enforces it.
--
-- Setting up is a thing that happens once, and "check whether it has happened,
-- then do it" is two statements that two requests can interleave — both read
-- "not yet" and both proceed. A primary key that can only hold one value makes
-- the second one fail in Postgres instead of in our logic.
CREATE TABLE installation (
    singleton   BOOLEAN     PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    org_id      TEXT        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Settings an operator chooses in the interface rather than in a file.
--
-- The GitHub client id is the first: it arrives through the setup wizard, or
-- through the connect-a-repository screen at the moment it is missed, and
-- either way it has to survive a restart without anyone editing anything.
CREATE TABLE settings (
    key         TEXT        PRIMARY KEY,
    value       TEXT        NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
