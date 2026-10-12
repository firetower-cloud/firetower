-- A checkout cut from a repository that had no commits in it.
--
-- There was no trunk to branch from, so the branch is a root of its own and
-- every count against its base has nothing to count against. Remembered here
-- rather than worked out later: "the base ref does not resolve" is also what a
-- deleted branch and a mistyped base look like, and treating those as a root
-- would report the whole repository as the work of one session.
ALTER TABLE session_repos ADD COLUMN unborn INTEGER NOT NULL DEFAULT 0;
