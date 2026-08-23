-- A pull request belongs to a repository, not to a session.
--
-- Two changes on one branch name in two repositories are two pull requests
-- that point at each other, because no git host has an object spanning both.
-- `sessions.pull_request` stays, meaning the first one, for a caption that
-- wants a single link.

ALTER TABLE session_repos ADD COLUMN pull_request TEXT;

UPDATE session_repos r
   SET pull_request = s.pull_request
  FROM sessions s
 WHERE s.id = r.session_id AND r.position = 0 AND s.pull_request IS NOT NULL;
