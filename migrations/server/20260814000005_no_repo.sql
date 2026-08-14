-- A session can be a bare agent: somewhere to work, nothing checked out.
--
-- Without a repository there is no branch, no base and no worktree — so the
-- columns that describe a checkout stop being required rather than being
-- filled with something meaningless.
ALTER TABLE sessions ALTER COLUMN repo DROP NOT NULL;
ALTER TABLE sessions ALTER COLUMN branch DROP NOT NULL;
ALTER TABLE sessions ALTER COLUMN base DROP NOT NULL;
