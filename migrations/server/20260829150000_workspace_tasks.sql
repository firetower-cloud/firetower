-- Which task a worktree was cut for.
--
-- The one durable fact about a task. Everything else — the title, who it is
-- assigned to, whether it is still open — is read from the tracker on view,
-- because it is somebody else's source of truth and changes without telling us.
-- These two columns are ours: they say what this place is for, and they are
-- what lets the rail show `#5138` and shipping offer to close it.
--
-- On the workspace rather than the session: a worktree is cut for one task and
-- may hold several agents working on it.
--
-- The key is source-scoped ("github:acme/web#5138") so a second tracker cannot
-- collide with the first. The URL is stored beside it rather than rebuilt from
-- the key, because reconstructing somebody else's URL scheme is a guess that
-- breaks quietly when they change it.
alter table workspaces
  add column task_key text,
  add column task_url text;

comment on column workspaces.task_key is
  'Source-scoped id of the task this worktree is for, e.g. github:acme/web#5138';
comment on column workspaces.task_url is
  'Where to go and read that task';
