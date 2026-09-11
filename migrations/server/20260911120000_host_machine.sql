-- Several worker environments can belong to the same machine. Existing SSH
-- hosts are grouped by address and port; local environments share "local".
ALTER TABLE hosts ADD COLUMN machine TEXT;
