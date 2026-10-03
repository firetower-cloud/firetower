-- Who may see what, for several people who work together.
--
-- Until now the answer was one column. A workspace, an agent account and a
-- secret each carried the id of the person they belonged to, and every read
-- said `WHERE user_id = $me`. That is a complete answer to "is this mine" and
-- no answer at all to "may I see yours", which is the whole of collaboration.
--
-- ## The shape
--
-- **A path says where a thing lives, and where it lives says who can reach it.**
-- Two roots, and only two:
--
--     u.<person>.<name…>     nobody else's business
--     d.<directory>.<name…>  whoever has a grant on that directory
--
-- The first two labels are the *permission root* — `subpath(path, 0, 2)` — and
-- nothing below them adds any authority. `d.backend.ledger.rounding` is filed
-- in `backend`, full stop; the extra labels are a name with slashes in it, for
-- people to read. That is deliberate and it is the whole reason this does not
-- need a recursive query: a tree for legibility, one segment for permission.
--
-- **A team is not a root.** It groups people, not things. `t/backend/…` was
-- considered and dropped: it carries no level, and it could never be shared
-- with a second team. "The backend team's work" is a *directory* named
-- `backend` with that team granted on it, which says the same thing, keeps
-- viewer/writer/admin, and can be opened to a second team tomorrow.
--
-- **Assigning transfers ownership.** Filing something under `d.backend` hands
-- it to that directory; whoever put it there keeps access only as somebody the
-- directory grants. That is the Windmill rule and it is chosen deliberately —
-- one source of authority, no second concept. `created_by` is kept on every
-- resource so the record of who made a thing survives it changing hands.
--
-- ## ltree
--
-- Labels are `[A-Za-z0-9_-]`: `'Ledger work'` is a syntax error, so every root
-- carries a `slug` beside its display name and the two are different columns on
-- purpose. `<@` answers "is this under that" against a GiST index, which is
-- what makes "everything in this directory" one indexed predicate rather than a
-- join.
-- Into `public` explicitly, and every connection keeps `public` on its search
-- path (see `Db::open_for_test`, where each test works in a schema of its own
-- and would otherwise not find the type).
--
-- `ltree` is a *trusted* extension, so the database owner can install it
-- without being superuser — which is what a deployment's own user is.
create extension if not exists ltree with schema public;

-- ── who ─────────────────────────────────────────────────────────────────

-- Everything that can be granted access, and can still be named after it is
-- gone.
--
-- **One table for both kinds**, because a person and a team are the same thing
-- to every part of this feature: a grant names one, an exception on a resource
-- names one, and a path is built from one. `users` and `teams` hold what
-- differs — a password, a membership list — and this holds what they share.
--
-- **A principal is never deleted.** Removing somebody deletes their `users`
-- row, and the cascades take their sessions and memberships with it, but this
-- row stays with `retired_at` set. Three things depend on that:
--
--   * `slug` is never reused. An exception written on somebody else's
--     workspace — `{"u/kevin": "writer"}` — outlives Kevin entirely, and a new
--     Kevin must not inherit it. The unique index below is what enforces that,
--     and it only works because the row survives;
--   * `created_by` can point here without being nullable. It used to reference
--     `users` with `on delete set null`, so "who added this machine" evaporated
--     the day they left. A resource always had a creator; the column should not
--     be able to say otherwise;
--   * `name` keeps what they were called, so a list can say "Kevin Piacentini
--     (removed)" rather than a blank.
--
-- **`slug` lives here, not on `users`.** It is the label every path of theirs
-- begins with and the key every ACL entry names, so it belongs to the identity
-- rather than to the account.
create table principals (
    id          text primary key,
    org_id      text not null references organizations(id) on delete cascade,
    kind        text not null check (kind in ('user', 'team')),
    -- Derived once from the name, immutable, never reused. Not the username:
    -- usernames are chosen by people and may yet become email addresses, and
    -- `kevin@westlabs.com` is not a legal ltree label — the `@` and the dots
    -- end it.
    slug        text not null,
    -- What they are called, as of now or as of their removal.
    name        text not null,
    -- Null while they are here.
    retired_at  timestamptz,
    created_at  timestamptz not null default now()
);

insert into principals (id, org_id, kind, slug, name)
select u.id, u.org_id, 'user',
       trim(both '_' from regexp_replace(lower(u.username), '[^a-z0-9]+', '_', 'g')),
       u.username
  from users u;

-- The one team every organisation gets. Its principal is written here, with the
-- people, so that the dedup below covers it: somebody whose username slugs to
-- `everyone` is unlikely but possible, and the index would otherwise refuse the
-- team rather than number the person.
insert into principals (id, org_id, kind, slug, name)
select 't_' || substr(o.id, 3), o.id, 'team', 'everyone', 'Everyone'
  from organizations o;

-- Two people whose names slug the same get a number, deterministically by id.
-- Before the unique index, not after: `Ana Lopez` and `ana.lopez` both arrive as
-- `ana_lopez`, so the index would refuse the second insert rather than let this
-- separate them.
update principals p set slug = p.slug || '_' || n.row
  from (select id, row_number() over (partition by org_id, slug
                                          order by kind desc, id) as row
          from principals) n
 where n.id = p.id and n.row > 1;

-- The invariant the whole design rests on: one slug, one principal, forever.
create unique index principals_by_slug on principals (org_id, slug);

-- So `users` and `teams` can carry `org_id` for their own unique indexes —
-- `unique (org_id, username)` cannot be built across two tables — without the
-- two ever being able to disagree. The database enforces the agreement rather
-- than the code remembering to.
create unique index principals_id_org on principals (id, org_id);

alter table users add constraint users_are_principals
    foreign key (id) references principals(id);
alter table users add constraint users_org_matches_principal
    foreign key (id, org_id) references principals (id, org_id);

create table teams (
    id          text primary key references principals(id),
    org_id      text not null references organizations(id) on delete cascade,
    name        text not null,
    -- Everybody in the organisation, without a row each.
    --
    -- A flag rather than a membership row per person, because the membership
    -- that has to be true is "however many people exist right now". Maintained
    -- as rows it would be a trigger and a backfill and, eventually, somebody
    -- added to the organisation and not to this — a person who silently cannot
    -- see what everybody can see. Resolved instead, in the view below.
    everyone    boolean not null default false,
    created_by  text references principals(id),
    created_at  timestamptz not null default now(),
    -- See `principals_id_org`: the copy of `org_id` above exists so the unique
    -- index below can be built, and this stops it drifting.
    foreign key (id, org_id) references principals (id, org_id)
);

-- Two teams called `Backend` and `backend` are a mistake being made, not a
-- distinction being drawn.
create unique index teams_by_name on teams (org_id, lower(name));
create unique index teams_everyone on teams (org_id) where everyone;

create table team_members (
    team_id   text not null references teams(id) on delete cascade,
    user_id   text not null references users(id) on delete cascade,
    added_at  timestamptz not null default now(),
    primary key (team_id, user_id)
);

create index team_members_by_user on team_members (user_id);

-- ── where ───────────────────────────────────────────────────────────────

create table directories (
    id          text primary key,
    org_id      text not null references organizations(id) on delete cascade,
    name        text not null,
    -- What appears in a path. Derived once, like a principal's — but reusable
    -- once the directory is gone, because `delete_directory` refuses while
    -- anything is filed here. Nothing can be pointing at `d/backend` at the
    -- moment it dies, which is exactly what is not true of a person.
    slug        text not null,
    created_by  text references principals(id),
    created_at  timestamptz not null default now()
);

create unique index directories_by_name on directories (org_id, lower(name));
create unique index directories_by_slug on directories (org_id, slug);

-- `subject_id` points at a user or a team — which is why it carries no foreign
-- key in most designs. Here it can: both are principals, so one reference
-- covers both, and the database checks what used to be checked by hand.
--
-- It does not cascade, because a principal is never deleted. Removing somebody
-- deletes their grants explicitly; what this stops is a grant naming an id that
-- was never anybody.
create table grants (
    directory_id  text not null references directories(id) on delete cascade,
    subject_kind  text not null check (subject_kind in ('person', 'team')),
    subject_id    text not null references principals(id),
    -- `viewer` may look, `writer` may work, `admin` may also change who else
    -- can. Ranked by `level_rank`, which is the only place the order is
    -- written down.
    level         text not null check (level in ('viewer', 'writer', 'admin')),
    granted_by    text references principals(id),
    granted_at    timestamptz not null default now(),
    primary key (directory_id, subject_kind, subject_id)
);

create index grants_by_subject on grants (subject_kind, subject_id);

create function level_rank(level text) returns integer
    language sql immutable strict
    as $$ select case level when 'admin' then 3 when 'writer' then 2 when 'viewer' then 1 else 0 end $$;

-- Every way a person reaches a directory, reduced to the best one.
--
-- **The join to `users` is what makes a principal's retirement bite.** A grant
-- naming somebody who has been removed still exists — the row references a
-- principal, which is never deleted — but they have no `users` row, so it
-- resolves to nothing here rather than to access. Removing their grants on the
-- way out is hygiene; this is the guarantee.
--
-- The single answer to "may they, and how much". Three routes in, and somebody
-- can have all three at once — granted directly, and in two teams that were
-- both granted. `max` is why two grants never need a tie-break rule: the most
-- access anybody was deliberately given is what they have.
create view directory_access as
select
    reached.directory_id,
    reached.user_id,
    max(reached.rank) as rank,
    case max(reached.rank) when 3 then 'admin' when 2 then 'writer' else 'viewer' end as level
from (
    select g.directory_id, g.subject_id as user_id, level_rank(g.level) as rank
      from grants g join users u on u.id = g.subject_id
     where g.subject_kind = 'person'
    union all
    select g.directory_id, m.user_id, level_rank(g.level)
      from grants g join team_members m on m.team_id = g.subject_id
     where g.subject_kind = 'team'
    union all
    -- The team that is everybody. No membership rows to go stale: whoever is in
    -- the organisation now is who this is.
    select g.directory_id, u.id, level_rank(g.level)
      from grants g
      join teams t on t.id = g.subject_id and t.everyone
      join users u on u.org_id = t.org_id
     where g.subject_kind = 'team'
) reached
group by reached.directory_id, reached.user_id;

-- ── what is filed ───────────────────────────────────────────────────────

-- A path on each kind that a person can file, and `created_by` beside it.
--
-- Nullable on `secrets` alone, and that is the rule rather than an exception:
-- a secret in the `agent` or `env:` scope is *attached* — it is an agent
-- account's credential or a repository's variable, it belongs to that thing,
-- and it moves when that thing moves. Attached things get no path, because a
-- path they could drift from their parent is how a subscription ends up filed
-- in one directory with its token still sitting in another.
alter table workspaces     add column path ltree;

-- `user_id` meant *owner* before a path did. Every read that asked it — the
-- `WHERE user_id = $me` that used to be the whole of access control — now asks
-- `filed_where` instead, so what is left is the record of who made it, spelled
-- the way the other three kinds spell it. Three call sites, all of them writes
-- or a join for a display name.
alter table workspaces     rename column user_id to created_by;
alter table workspaces     alter column created_by drop not null;
alter table workspaces     drop constraint workspaces_user_id_fkey;
alter table workspaces     add constraint workspaces_created_by_fkey
    foreign key (created_by) references principals(id);
-- **`created_by` is null only for rows that predate it.** It can never become
-- null because somebody left — that is the whole reason it points at
-- `principals`, which is never deleted. A machine that existed before this
-- migration genuinely has no recorded creator: nothing wrote one down, and
-- guessing at the first administrator would put a name on a decision they may
-- not have made.
alter table hosts          add column path ltree, add column created_by text references principals(id);
alter table agent_accounts add column path ltree;
alter table secrets        add column path ltree, add column created_by text references principals(id);

-- `repos` gets one too, and it is the kind that never moves: always
-- `u/<slug>`, never a directory. What opens a repository is the token of
-- whoever connected it, so the row is theirs in the strong sense. The backfill
-- and the constraints are at the end of this file, after principals have their
-- slugs.

-- One organisation, one directory everything shared starts in.
insert into directories (id, org_id, name, slug)
select 'd_' || substr(o.id, 3), o.id, 'Shared', 'shared' from organizations o;

insert into teams (id, org_id, name, everyone)
select 't_' || substr(o.id, 3), o.id, 'Everyone', true from organizations o;

-- Everybody may work in the shared directory, which is what compute has always
-- been: a machine belongs to the organisation and every one of them runs on it.
insert into grants (directory_id, subject_kind, subject_id, level)
select 'd_' || substr(o.id, 3), 'team', 't_' || substr(o.id, 3), 'writer' from organizations o;

-- A workspace goes to whoever made it.
update workspaces w
   set path = ('u.' || u.slug || '.' ||
               trim(both '_' from regexp_replace(lower(coalesce(nullif(w.name, ''), 'workspace')), '[^a-z0-9]+', '_', 'g')) ||
               '_' || substr(w.id, 3, 8))::ltree
  from principals u where u.id = w.created_by;

update agent_accounts a
   set path = ('u.' || u.slug || '.' ||
               trim(both '_' from regexp_replace(lower(a.name), '[^a-z0-9]+', '_', 'g')) ||
               '_' || substr(a.id, 1, 8))::ltree
  from principals u where u.id = a.user_id;

-- A machine is personal until somebody shares it, and that includes the ones
-- that already exist.
--
-- Nothing recorded who added them, so they go to the administrator who set the
-- installation up — the earliest one, which on every install that has not been
-- through a handover is the person who ran it the first time. Not `d.shared`:
-- the whole point of a default is that it is the safe one, and "every machine
-- in the fleet is reachable by everybody" is not a decision anybody here made.
-- Somebody who wants the old arrangement files them into `Shared`, which the
-- lines above have already created and granted to everyone, and that is one
-- move on one screen.
--
-- The cost, stated plainly: on an installation where several people were
-- already working on a shared fleet, they stop being able to start anything on
-- it until the administrator shares it back. That is a worse first minute after
-- an upgrade, in exchange for never silently publishing a machine somebody
-- added with their own key.
update hosts h
   set path = ('u.' || coalesce(
                   (select p.slug from principals p join users u on u.id = p.id
                     where p.org_id = h.org_id and p.kind = 'user' and u.role = 'admin'
                     order by p.id limit 1),
                   (select p.slug from principals p
                     where p.org_id = h.org_id and p.kind = 'user'
                     order by p.id limit 1))
               || '.' || trim(both '_' from regexp_replace(lower(h.name), '[^a-z0-9]+', '_', 'g')))::ltree;

-- A secret somebody authorized is theirs. One an agent account or a repository
-- owns is attached and gets none, and neither does the install's own.
update secrets s
   set path = ('u.' || u.slug || '.' || s.scope || '.' ||
               trim(both '_' from regexp_replace(lower(s.name), '[^a-z0-9]+', '_', 'g')))::ltree
  from principals u
 where u.id = s.owner and s.scope not in ('agent') and s.scope not like 'env:%';

alter table workspaces     alter column path set not null;
alter table hosts          alter column path set not null;
alter table agent_accounts alter column path set not null;

-- ── exceptions ──────────────────────────────────────────────────────────

-- A few named people on one resource, on top of where it lives.
--
-- A directory is how a company shares a body of work; this is how one person
-- lets one colleague into one thing. Without it the only way to show Lisa a
-- workspace is to create a directory containing both of you and hand the
-- workspace to it — which is a lot of machinery for "let Lisa see this", and
-- which transfers ownership as a side effect.
--
--     {"u/lisa": "writer", "t/backend": "viewer"}
--
-- **A fourth route in, not a second source of authority.** `directory_access`
-- already reduces three routes — granted directly, granted through a team,
-- granted through the team that is everybody — with `max`. This is one more
-- input to the same `max`, so two answers can never contradict: the most access
-- anybody was deliberately given is what they have.
--
-- Four rules, and each closes something:
--
--   * **keys are slugs, values are `viewer` or `writer`.** Never `admin` —
--     administration stays with the path, so exactly one place answers "who may
--     change permissions". An admin-by-exception could otherwise rewrite the
--     grants of the directory they were only an exception to;
--   * **additive only.** There is no way to spell a denial. Deny rules are what
--     make a permission system impossible to reason about, and we have none;
--   * **never ownership.** The path and `created_by` stay the record of whose a
--     thing is. An exception is access;
--   * **only on what can be filed.** Nothing attached — an agent account's
--     credential, a repository's variables, the install's own secrets. An
--     exception on one of those would be a way to reach a subscription's token
--     without reaching the subscription.
--
-- The keys naming a departed principal are swept on the way out, but that is
-- hygiene: what makes a stale `{"u/ana": "writer"}` harmless is that `ana` is
-- never issued to anybody again. See `principals`.
alter table workspaces     add column extra_perms jsonb not null default '{}';
alter table hosts          add column extra_perms jsonb not null default '{}';
alter table agent_accounts add column extra_perms jsonb not null default '{}';
alter table secrets        add column extra_perms jsonb not null default '{}';

-- `jsonb_ops`, the default — not `jsonb_path_ops`, which is smaller and
-- supports only `@>`. The access check asks `?` ("is this key here") and `?|`
-- ("is any of these keys here"), and only the default operator class indexes
-- those.
create index workspaces_extra_perms     on workspaces     using gin (extra_perms);
create index hosts_extra_perms          on hosts          using gin (extra_perms);
create index agent_accounts_extra_perms on agent_accounts using gin (extra_perms);
create index secrets_extra_perms        on secrets        using gin (extra_perms);

-- `<@` against these is the whole access check.
create index workspaces_by_path     on workspaces     using gist (path);
create index hosts_by_path          on hosts          using gist (path);
create index agent_accounts_by_path on agent_accounts using gist (path);
create index secrets_by_path        on secrets        using gist (path);

-- One thing per place, per kind.
create unique index workspaces_path_unique     on workspaces (path);
create unique index hosts_path_unique          on hosts (path);
create unique index agent_accounts_path_unique on agent_accounts (path);
create unique index secrets_path_unique        on secrets (path) where path is not null;

-- ── repositories are personal ────────────────────────────────────
--
-- A repository belongs to whoever connected it, and to nobody else.
--
-- Left outside the model, `repos` had no path, so no `filed_where`, so no
-- filter: the list was `SELECT *` for anybody signed in, and six handlers
-- never looked at the caller. A member could read, rewrite or delete any
-- repository in the organisation, including its setup script — a shell command
-- the worker runs in every session cut from it.
--
-- These are personal in the strong sense. They live under `u/<slug>`, which
-- `may_share` refuses to move for anybody, administrators included. There is
-- no sharing them and no handing them on; when their owner goes, they go.

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

-- ── one mailbox, one account ───────────────────────────────────
--
-- `users.email` has been here since the first migration, nullable and unique
-- per organisation. What it was not is case-insensitive, so
-- `Kevin@westlabs.com` and `kevin@westlabs.com` could both exist: one inbox,
-- two accounts, and a support ticket nobody should have to answer. Addresses
-- are required for anybody added from now on, so this is the moment to settle
-- it.
--
-- Nulls still do not collide, which is what lets the accounts made before
-- anybody was asked for one carry on with none. Nothing is invented for them:
-- a placeholder like `changeme@…` cannot be told apart from a real address
-- that bounces, and the first time this installation sends anything, "who have
-- we actually failed to reach" is precisely the question.

-- **The ones that already collide, first.** The old index compared the text,
-- so an installation can be sitting on `Kevin@westlabs.com` and
-- `kevin@westlabs.com` right now — and creating the new index on a database
-- holding both fails, which fails the migration, which stops the control plane
-- from starting. An upgrade that bricks an install over a duplicate address is
-- a far worse outcome than the duplicate.
--
-- The earliest account keeps the address; the later ones lose it and keep
-- everything else. That is the same answer this file gives to accounts made
-- before anybody was asked for one: no address, and a prompt on the People
-- screen. Nothing is invented for them, and nobody is locked out.
update users u
   set email = null
 where u.email is not null
   and exists (
     select 1
       from users other
      where other.org_id = u.org_id
        and other.email is not null
        and lower(other.email) = lower(u.email)
        and other.id < u.id
   );

drop index users_by_email;
create unique index users_by_email on users (org_id, lower(email));
