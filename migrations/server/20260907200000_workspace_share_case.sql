-- `share` is read back through serde, and `Share` renames to camelCase — so
-- the column holds `yields`, `equal` and `takesMore`, not the `Equal` the
-- previous migration defaulted to. Unlike `size`, whose enum has no rename and
-- whose `Medium` default is what serde writes.
--
-- Every row seeded by that default fails to decode, and the session and
-- workspace reads that select the column 500 rather than returning a row.
update workspaces set share = 'yields' where share = 'Yields';
update workspaces set share = 'equal' where share = 'Equal';
update workspaces set share = 'takesMore' where share = 'TakesMore';

alter table workspaces alter column share set default 'equal';
