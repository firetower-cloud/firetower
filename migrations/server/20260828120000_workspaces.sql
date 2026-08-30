-- A workspace is the place; a session is the work done in it.
--
-- These were one row. `sessions` held the worktree — the host, the repository,
-- the branch it was cut from, how big the machine is — and the agent working in
-- it, welded together. Three things followed from that, all of them wrong:
--
--   * a second agent on the same branch was impossible, because `agent` was a
--     column rather than a list;
--   * ending the work destroyed the place, because they were the same row;
--   * "session" named both, which is why nothing could be said about one
--     without saying it about the other.
--
-- So the worktree moves out. This migration changes no behaviour: every session
-- becomes a workspace holding exactly one session, and the code keeps that
-- invariant. What it buys is that the invariant is now a *choice* rather than a
-- property of the schema, and lifting it is the next change rather than a
-- rewrite.
--
-- Ids are deliberately not regenerated. A workspace takes the id of the session
-- it came from, so the worker's directory names and tmux sessions — which are
-- built from the session id and live on other people's machines — keep pointing
-- at the same things. Nothing on a host has to move.

create table workspaces (
    id            text primary key,
    -- Whoever made it. A run inside it carries its own owner as well, so this
    -- does not have to be the only answer later on.
    user_id       text not null references users(id) on delete cascade,
    host_id       text not null references hosts(id) on delete cascade,
    -- The first checkout's slug and branch, denormalised for a caption. The
    -- authoritative per-repository values are in `workspace_repos`.
    repo          text,
    branch        text,
    base          text,
    size          text not null default 'Medium',
    -- Where the pull request went, when the whole workspace has one. Per
    -- checkout in `workspace_repos` when it holds several.
    pull_request  text,
    -- Physical facts about the directory on the host: when it was removed here
    -- without the machine being told, and when the machine was finally told.
    forgotten_at  timestamptz,
    cleaned_at    timestamptz,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

create index workspaces_by_host  on workspaces (host_id);
create index workspaces_by_owner on workspaces (user_id, updated_at);

-- One workspace per session that exists, keeping its id.
insert into workspaces
    (id, user_id, host_id, repo, branch, base, size, pull_request,
     forgotten_at, cleaned_at, created_at, updated_at)
select
    id, user_id, host_id, repo, branch, base, size, pull_request,
    forgotten_at, cleaned_at, created_at, updated_at
from sessions;

alter table sessions add column workspace_id text references workspaces(id) on delete cascade;
update sessions set workspace_id = id;
alter table sessions alter column workspace_id set not null;

create index sessions_by_workspace on sessions (workspace_id);

-- What is checked out belongs to the place, not to the work: two agents in one
-- workspace read the same files out of the same directories.
alter table session_repos rename to workspace_repos;
alter table workspace_repos rename column session_id to workspace_id;

-- The old foreign key still points at `sessions`. Since the ids match it would
-- keep working, but it would mean deleting a session took its checkouts with
-- it — which is exactly the coupling this migration exists to remove.
alter table workspace_repos drop constraint session_repos_session_id_fkey;
alter table workspace_repos
    add constraint workspace_repos_workspace_id_fkey
    foreign key (workspace_id) references workspaces(id) on delete cascade;

-- Now that they live on the workspace, drop them here. Two writable copies of
-- the branch is how the two disagree.
alter table sessions drop column host_id;
alter table sessions drop column repo;
alter table sessions drop column branch;
alter table sessions drop column base;
alter table sessions drop column size;
alter table sessions drop column pull_request;
alter table sessions drop column forgotten_at;
alter table sessions drop column cleaned_at;
