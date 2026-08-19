-- How much the note on a session actually tells you.
--
-- A blocked agent reports from several hooks within seconds, and they do not
-- arrive best-first: a permission request naming the tool, then a stop hook
-- reading a stale sentence out of the transcript. Without something to compare
-- against, the last one wins and the card gets worse the longer you wait.
ALTER TABLE sessions ADD COLUMN note_rank INTEGER NOT NULL DEFAULT 0;
