-- Where a repository's environment file goes, when it wants one.
--
-- The variables themselves live in the vault, encrypted, under the scope
-- `repo:<id>`. This is only the path — `.env` for most, empty for the many
-- repositories whose tooling reads the environment directly and needs no file
-- at all.
ALTER TABLE repos ADD COLUMN env_file TEXT;
