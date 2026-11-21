-- Agent teams: structure, taken out of the profile and given an object.
--
-- A profile used to carry who it could hand work to, in `roles.delegate_scope`
-- and `roles.can_delegate`. That made teams exist in effect without existing
-- as a thing — you could not see who was capable of what, a profile's children
-- travelled with it into every team that borrowed it, delegation could only be
-- one level deep, and the default was unbounded.
--
-- So: a **profile is identity** — its name, what it does, its instructions, its
-- skills, how it runs — and a **team is structure**. A team is a tree of
-- positions; a position references a profile and may add instructions that
-- apply only there. The Designer in two teams is two positions referencing one
-- profile, with different children in each, because the team says so and the
-- profile says nothing.
--
-- Three things are worth reading before changing this.
--
-- **The lead is a position, not a column.** A team's lead is its root position
-- — the one with no parent — and `agent_teams_one_lead` makes it exactly one.
-- A `lead_role_id` beside the tree would be the same fact written twice, and
-- the two would drift the first time a lead was replaced.
--
-- **A profile may hold more than one position under the same parent.** Product
-- has two Engineers under its lead, one owning the web client and one the API,
-- told apart by their extra instructions. So there is no uniqueness over
-- (team, parent, profile), deliberately — a constraint there would refuse the
-- worked example in the specification's own file format.
--
-- **`on delete restrict` on the profile a position references.** Deleting a
-- profile that a team uses must not silently empty that team, so the delete is
-- refused and the refusal names the teams and the counts
-- (`agent_teams::holding`). The cascade-with-confirmation shape is the same
-- blast-radius question the map's remove control asks, and it is answered in
-- one place rather than by the database quietly.

-- ── the team ──────────────────────────────────────────────────────────

create table agent_teams (
    id          text primary key,
    org_id      text not null references organizations(id) on delete cascade,
    -- Placed, exactly as a profile or a skill is — see
    -- `docs/paths-and-ownership.md`. One predicate answers "may I see this"
    -- and nothing here invents a second. `ft_core::ResourcePath` is the only
    -- thing that writes one.
    path        ltree not null,
    created_by  text references principals(id) on delete set null,
    -- A few named people on one team, over and above where it lives. Same
    -- shape and same meaning as a profile's.
    extra_perms jsonb not null default '{}',

    name        text not null,
    -- Unique per installation, so two people's `product` teams do not collide
    -- on the path's own uniqueness. A discriminator is appended at creation.
    slug        text not null,

    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create unique index agent_teams_by_path on agent_teams (path);
create index agent_teams_path_tree on agent_teams using gist (path);
create unique index agent_teams_slug on agent_teams (org_id, slug);
create index agent_teams_by_creator on agent_teams (created_by);

comment on table agent_teams is
  'A lead profile and the tree of positions under it. Placed, like a profile.';

-- ── the positions ─────────────────────────────────────────────────────

create table team_positions (
    id                 text primary key,
    team_id            text not null references agent_teams(id) on delete cascade,
    -- Null for the lead. A position owns its subtree, so removing one removes
    -- its children — which is what the map's remove control states the count
    -- of before it happens.
    parent_id          text references team_positions(id) on delete cascade,
    -- `restrict`, not `cascade`: see the header. A profile a team uses cannot
    -- be deleted out from under it without somebody reading a sentence first.
    role_id            text not null references roles(id) on delete restrict,
    -- Markdown that applies to this profile *in this team only*. It never
    -- replaces a profile field — it is composed after the profile's own
    -- instructions — so there is no resolution order to define and no
    -- override semantics to explain. That is why the field is
    -- `extra_instructions` and the screen says "extra instructions".
    extra_instructions text not null default '',
    -- Authoritative, and preserved by import and export both. The map draws
    -- siblings in this order and new positions append; without it a round
    -- trip returns a different file and every diff is noise.
    ordinal            integer not null default 0,
    created_at         timestamptz not null default now()
);

create index team_positions_by_team on team_positions (team_id, parent_id, ordinal);
create index team_positions_by_role on team_positions (role_id);

-- Exactly one root. A team with two leads is not a tree, and a team with none
-- cannot be started — the composer picks a team by naming its lead.
create unique index agent_teams_one_lead
    on team_positions (team_id)
 where parent_id is null;

comment on table team_positions is
  'One profile, where it sits in one team, and what is said to it only there.';

-- ── what a session occupies ───────────────────────────────────────────
--
-- Reach is resolved from the tree at run time, so a session has to know which
-- position it occupies: composing a lead's prompt reads that position's
-- children, and resolving a name at spawn does the same. A child inherits the
-- position it was spawned into, which is how depth works at all — the old
-- model could only ever be one level deep because a child had no place to
-- stand.
--
-- `set null`, matching `sessions.profile_id`: deleting a team must not take
-- the running sessions with it. A session whose position has gone keeps going
-- and simply stops being able to hand work on, which is the same thing that
-- happens to a session whose profile was deleted.
alter table sessions
    add column team_id     text references agent_teams(id) on delete set null,
    add column position_id text references team_positions(id) on delete set null;

create index sessions_by_team on sessions (team_id) where team_id is not null;

comment on column sessions.position_id is
  'Which position in its team this session occupies. Its children are the only profiles it may spawn.';

-- ── the compatibility window ──────────────────────────────────────────
--
-- `roles.can_delegate` and `roles.delegate_scope` are **deprecated and still
-- read**, and the end of the window is when they are dropped. Nothing writes
-- them any more: the editor has no delegation controls, the MCP server refuses
-- the keys by name, and a profile bundle carrying `delegates_to` is refused
-- with the conversion offered.
--
-- They are still read because a session that started before the cut has to
-- finish normally, and because an installation that had delegating profiles on
-- the morning of the upgrade must not find its agents mute that afternoon. A
-- session with a position resolves from its team; a session without one falls
-- back to the old reach and the interface says, on the profile itself, that it
-- is doing so.
--
-- The comment is the deprecation notice the schema itself carries, so the next
-- person to read these columns learns it here rather than from behaviour.
comment on column roles.can_delegate is
  'DEPRECATED — delegation moved to agent_teams. Still read for a session with no position, during the compatibility window. Nothing writes it.';
comment on column roles.delegate_scope is
  'DEPRECATED — delegation moved to agent_teams. Still read for a session with no position, during the compatibility window. Nothing writes it.';
