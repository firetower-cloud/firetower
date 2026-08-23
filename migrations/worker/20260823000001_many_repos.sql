-- A session holds more than one repository. See the control plane's migration
-- of the same name; this is the half the worker needs to do the work.
--
-- `path` is relative to the workspace. Empty means the checkout *is* the
-- workspace — how every session made before this is laid out on disk.

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

INSERT INTO session_repos (session_id, position, slug, remote, base, branch, path)
SELECT id, 0, repo, '', base, branch, ''
FROM sessions
WHERE repo IS NOT NULL AND branch IS NOT NULL AND base IS NOT NULL;
