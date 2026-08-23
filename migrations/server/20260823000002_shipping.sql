-- What a session has done about getting its work out.
--
-- Both of these were produced already and thrown away: a pull request was
-- opened and its address handed to whoever asked, and nothing remembered it.
-- So the next screen to load had no way to tell "pushed" from "already open",
-- and the only control anybody could offer was a menu of every verb with no
-- idea which one applied.
--
-- Knowing this is what lets one button say the next honest thing.

-- Where the pull request is, once there is one.
--
-- The address rather than a number: it is what somebody wants to click, it
-- identifies the provider as well as the request, and it survives a repository
-- being renamed in a way an integer does not.
ALTER TABLE sessions ADD COLUMN pull_request TEXT;

-- What the agent proposed calling this work.
--
-- Written when a session hands back, before anybody asks — the moment it stops
-- is the moment it knows most, and a description waiting to be edited is worth
-- more than a box waiting to be filled.
--
-- A draft in every sense: kept apart from anything git or GitHub holds, and
-- replaced whenever the agent produces a newer one. Nothing reads it except
-- the review sheet, which lets somebody change it before it goes anywhere.
ALTER TABLE sessions ADD COLUMN proposed_title TEXT;
ALTER TABLE sessions ADD COLUMN proposed_body TEXT;
