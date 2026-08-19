-- Why a session is waiting on you.
--
-- The agent's own words, carried on the status change that stopped it: the
-- permission it wants, the last thing it said, the error that ended the turn.
--
-- Without it, a blocked session is a red dot you have to open a terminal to
-- understand — and opening the terminal is most of the cost of being
-- interrupted, which is the cost this product exists to remove.
ALTER TABLE sessions ADD COLUMN note TEXT;
