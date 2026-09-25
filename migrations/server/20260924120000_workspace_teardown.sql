-- Reclaiming a workspace's data when it is torn down.
--
-- Nothing on the session path was ever deleted. `forgotten_at` and `cleaned_at`
-- are facts about the directory on the host; the rows stayed, so a Postgres
-- here grew without bound for as long as anybody used the product. Almost all
-- of the weight is `agent_lines`, which holds the agent's raw log verbatim —
-- including the base64 of every screenshot it captured.
--
-- The cascades to do the work were already in place. Two things stood in the
-- way, and both are fixed here.

-- ── A foreign key that refuses the delete ───────────────────────────────
--
-- `next_session_id` was declared with no `ON DELETE`, which in Postgres means
-- `NO ACTION`: deleting a session some switch points at fails the whole
-- statement. That is not only a problem for the purge — `DELETE FROM hosts`
-- already cascades into sessions, so removing a host could already fail this
-- way. A switch that pointed at a session which no longer exists is a switch
-- with nowhere to go, which is exactly what NULL means here.
alter table agent_account_switches
    drop constraint agent_account_switches_next_session_id_fkey;

alter table agent_account_switches
    add constraint agent_account_switches_next_session_id_fkey
    foreign key (next_session_id) references sessions(id) on delete set null;

-- ── A foreign key that was missing entirely ─────────────────────────────
--
-- `events.session_id` had no reference at all. `host_id` cascades from
-- `hosts`, which covered everything a worker sent — but `local_events` made
-- `host_id` nullable so the control plane could raise its own, and those rows
-- matched no cascade anywhere. Removing a host took its sessions and left
-- every control-plane event of theirs behind, permanently.
--
-- The orphans have to go before the constraint can be trusted. This is the one
-- unbatched delete here: these are events whose session is already gone, which
-- is a small set next to `agent_lines`, and the volume that needs batching is
-- handled by the sweep in the control plane rather than by a migration that
-- would hold a lock for the length of it.
delete from events e
 where not exists (select 1 from sessions s where s.id = e.session_id);

alter table events
    add constraint events_session_id_fkey
    foreign key (session_id) references sessions(id) on delete cascade;

-- ── The debt that has to outlive the rows ───────────────────────────────
--
-- A workspace removed while its host is unreachable is owed a teardown: the
-- agent is still running there, in a worktree that still exists, and the next
-- time that machine connects it has to be told. Until now that debt was read
-- off the workspace itself — `forgotten_at IS NOT NULL AND cleaned_at IS NULL`
-- — which works only for as long as the row is kept.
--
-- Purging the row would therefore lose the debt, and a host that came back
-- later would keep a live agent and its directory forever. So the debt is
-- recorded separately, in the terms the worker is actually told in: a session
-- id, which is what `ToWorker::Destroy` takes. It is deliberately free of any
-- reference to `sessions` — outliving that row is the whole point of it.
create table owed_teardowns (
    host_id      text not null references hosts(id) on delete cascade,
    session_id   text not null,
    forgotten_at timestamptz not null default now(),
    primary key (host_id, session_id)
);

create index owed_teardowns_by_host on owed_teardowns (host_id, forgotten_at);

-- Everything already removed here and never confirmed there is owed the same
-- teardown, so it carries over rather than being dropped on the floor by the
-- sweep that is about to purge those workspaces.
insert into owed_teardowns (host_id, session_id, forgotten_at)
select w.host_id, s.id, w.forgotten_at
  from sessions s
  join workspaces w on w.id = s.workspace_id
 where w.forgotten_at is not null
   and w.cleaned_at is null
on conflict do nothing;
