-- The original `credentials` table was designed before agent configuration
-- existed and was never written to: its columns (label, placement, expires_at)
-- describe a model that didn't survive contact with the problem. The `agents`
-- table added in the previous migration is what actually holds configuration.
--
-- Replace it with what's genuinely needed: a record of which keychain entries
-- exist, so that asking "is a credential set?" doesn't read the secret.
-- Reading one is a blocking call the operating system may gate behind a user
-- prompt, which has no business in an endpoint that renders a screen.
--
-- This is a flag, never a value. It can drift if someone edits their keychain
-- by hand; that surfaces the next time the credential is used, which is the
-- only moment it matters.
DROP TABLE credentials;

CREATE TABLE credentials (
    scope TEXT NOT NULL,
    name  TEXT NOT NULL,
    PRIMARY KEY (scope, name)
);
