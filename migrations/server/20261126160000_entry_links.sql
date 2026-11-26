-- The same two links, and the scopes, on the catalogue row.
--
-- So a refresh can carry them to something installed before its entry
-- declared any. Without this, deleting the hardcoded table of consoles from
-- the control plane takes the link away from everything already installed,
-- and the answer becomes "remove the server and add it again" — worse than
-- the table was.
alter table marketplace_entries add column console text;
alter table marketplace_entries add column guide   text;
alter table marketplace_entries add column scopes  text;
