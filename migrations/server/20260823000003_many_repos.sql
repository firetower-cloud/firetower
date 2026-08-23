-- A session holds more than one repository.
--
-- `sessions.repo`, `.branch` and `.base` describe exactly one checkout, which
-- is the shape a session has had until now. They stay, meaning *the first*
-- checkout, because a list row wants one name and because every session that
-- already exists has exactly one. What is authoritative lives here.
--
-- `path` is relative to the workspace. Empty means the checkout *is* the
-- workspace, which is how every session made before this migration is laid out
-- on disk — those directories are not moving.

CREATE TABLE session_repos (
    session_id  TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    -- The order they were added in, and the order they are drawn in.
    position    INT  NOT NULL,
    -- Absent when the repository has since been disconnected. The slug is what
    -- the checkout is, and it does not stop being true.
    repo_id     TEXT,
    slug        TEXT NOT NULL,
    base        TEXT NOT NULL,
    -- What git actually cut, which is not always what was asked for: the same
    -- prompt twice wants the same branch name, and git numbers the second.
    branch      TEXT NOT NULL,
    path        TEXT NOT NULL DEFAULT '',
    -- Set when this repository could not be checked out, so a session that came
    -- up with two of three can say which one is missing rather than pretending.
    trouble     TEXT,
    PRIMARY KEY (session_id, position)
);

INSERT INTO session_repos (session_id, position, repo_id, slug, base, branch, path)
SELECT s.id, 0, r.id, s.repo, s.base, s.branch, ''
FROM sessions s
LEFT JOIN repos r ON r.slug = s.repo
WHERE s.repo IS NOT NULL AND s.branch IS NOT NULL AND s.base IS NOT NULL;
