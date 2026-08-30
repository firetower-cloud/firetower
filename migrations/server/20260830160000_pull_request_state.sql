-- What became of a pull request, beside the address of it.
--
-- The address was all we kept, so a merged request and one nobody has opened
-- yet looked the same: the only call that read a request back asked GitHub for
-- `state=open`, which cannot see the two answers worth having. A workspace
-- therefore stayed open for ever, whatever happened to the change in it.
--
-- Null means nobody has asked. Distinct from `open`, which means we asked and
-- it is still waiting for a reviewer.
alter table workspace_repos add column pull_state text;
alter table workspace_repos add column pull_checked_at timestamptz;
