-- A name belongs to the place, and should say what the work is.
--
-- `name` was on `sessions` and defaulted to `'Agent ' || number`, because a
-- session used to be the agent. So a rail of workspaces read `Agent 8`,
-- `Agent 9`, `Agent 11` — a column of inventory numbers, none of which says
-- anything about what is in them.
--
-- It moves to the workspace, and its default becomes the branch's slug:
-- `split-refresh-path` rather than `Agent 14`. `number` stays on the session,
-- because a short unambiguous handle is still worth having — it is only the
-- wrong thing to *call* a workspace.

alter table workspaces add column name text;

update workspaces w
   set name = s.name
  from sessions s
 where s.workspace_id = w.id
   and s.name is not null;

-- Anything still unnamed keeps the old form rather than being invented: these
-- are workspaces somebody has been looking at under that name.
update workspaces w
   set name = 'Agent ' || s.number
  from sessions s
 where s.workspace_id = w.id
   and w.name is null;

alter table workspaces alter column name set not null;

-- One writable copy. Two is how the rail and the header come to disagree.
alter table sessions drop column name;
