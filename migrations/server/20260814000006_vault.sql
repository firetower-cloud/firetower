-- The secret store.
--
-- Credentials used to live in the operating system's keychain, which cannot
-- work: a keychain belongs to one machine and one signed-in human, and this
-- control plane hands credentials to workers on other machines and to
-- containers with no desktop session at all. So they live here, encrypted, with
-- a root key that is deliberately not in this database.

CREATE TABLE secrets (
    scope       TEXT        NOT NULL,
    name        TEXT        NOT NULL,
    -- Sealed into the ciphertext along with the scope and name. A row copied
    -- from another name, or restored from before a rotation, fails to open
    -- rather than yielding the wrong credential.
    version     INTEGER     NOT NULL,
    -- This secret's own key, encrypted under the root key.
    wrapped_key BYTEA       NOT NULL,
    -- The value, encrypted under this secret's own key.
    ciphertext  BYTEA       NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (scope, name)
);

-- Every read, write and removal, with the reason it happened. Never a value.
--
-- `digest` covers this entry's fields and the previous entry's digest, keyed
-- with a value derived from the root key. Editing a row or deleting one breaks
-- every link after it, and re-forging the chain needs the key rather than just
-- a connection to this database.
CREATE TABLE secret_access (
    id        BIGSERIAL   PRIMARY KEY,
    scope     TEXT        NOT NULL,
    name      TEXT        NOT NULL,
    action    TEXT        NOT NULL,
    reason    TEXT        NOT NULL,
    at        TIMESTAMPTZ NOT NULL,
    previous  BYTEA,
    digest    BYTEA       NOT NULL
);

CREATE INDEX secret_access_by_secret ON secret_access (scope, name, id);

-- Which keychain entries existed. Nothing reads it now; the secrets table is
-- the answer to "is one set?".
DROP TABLE credentials;

-- This held an agent's token as given. There is now somewhere proper for it.
ALTER TABLE agents DROP COLUMN secret;
