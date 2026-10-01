-- A repository belongs to whoever connected it, and to nobody else.
--
-- `20260929120000_people_teams_and_paths` gave every other kind a path and
-- left this one out on purpose, saying "a repository is the organisation's and
-- always has been". That reasoning had the fact right and the conclusion
-- backwards: what opens a repository *is* the token of whoever connected it,
-- which is already theirs alone — so the row is theirs too.
--
-- Left as it was, `repos` sat outside the access model entirely. No path meant
-- no `filed_where`, which meant `SELECT * FROM repos` for anybody signed in,
-- and six handlers that never looked at the caller at all: a member could
-- read, rewrite or delete any repository in the organisation, including its
-- setup script — a shell command the worker runs in every session cut from it.
--
-- These are personal in the strong sense. They live under `u/<slug>`, which
-- `may_share` already refuses to move for anybody, administrators included.
-- There is no sharing them and no handing them on; when their owner goes, they
-- go.

alter table repos add column path ltree;

-- `added_by` has carried this since the first migration, for display. It was
-- the answer all along.
update repos r
   set path = ('u.' || p.slug)::ltree
  from principals p
 where p.id = r.added_by;

-- A repository whose owner has already left belongs to nobody, and under the
-- rule above it cannot be handed to anyone. There is nothing to do but let it
-- go. The `on delete cascade` below is what stops this case recurring.
delete from repos where path is null;

alter table repos alter column path set not null;
create index repos_by_path on repos using gist (path);

-- `on delete set null` was right while a repository was the organisation's:
-- the row outlived the person, because it was never theirs. Now it is theirs,
-- and the rule for everything personal is that removing somebody destroys what
-- is under their name rather than passing it on. The database says so itself,
-- so no code path can forget.
alter table repos drop constraint repos_added_by_fkey;
alter table repos add constraint repos_added_by_fkey
    foreign key (added_by) references users(id) on delete cascade;
alter table repos alter column added_by set not null;

-- One remote per person, not one per organisation.
--
-- This is the constraint that made the old behaviour inevitable: with
-- `(org_id, remote)` unique, the second person to connect `acme/backend` could
-- only ever be given the first person's row — so the row had to be everybody's.
-- Two people on one codebase is now two rows, each with its own setup script
-- and its own variables, which is what "personal" means when you say it out
-- loud.
alter table repos drop constraint repos_org_id_remote_key;
alter table repos add constraint repos_org_id_remote_path_key unique (org_id, remote, path);

-- Written in the very first migration for exactly this question and never once
-- read: `visibility` appears nowhere in the server. A column that can still say
-- 'org' is a column that contradicts the rule, and leaving it is an invitation
-- to implement the wrong one later.
alter table repos drop column visibility;
