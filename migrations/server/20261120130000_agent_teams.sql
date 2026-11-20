-- Agent teams: where a profile's reach actually lives.
--
-- **The thing being replaced is `roles.delegate_scope` and `roles.can_delegate`,
-- and the reason is one sentence: reach is a property of a relationship, not of
-- an agent.** The same Designer should be able to have three reports in one
-- team and none in another, and with the list bolted onto the profile row that
-- sentence cannot be expressed at all — a profile's children travelled with it
-- everywhere it was named.
--
-- So: a profile becomes identity only — its name, what it does, its
-- instructions, its skills, how it runs. A **team** is a name and the profile
-- that leads it. A team holds a tree of **positions**; a position references a
-- profile, has a parent, carries instructions that apply only there, and has an
-- explicit place among its siblings. An agent running in a position may hand
-- work to the profiles its children reference, and to nothing else.
--
-- **This is the expand half of an expand/contract.** Nothing is dropped here:
-- `can_delegate` and `delegate_scope` keep working for a session that occupies
-- no position, which is every session that exists. Dropping them is #497,
-- after a compatibility window. Both paths answer the same question and the
-- session decides which one asks it — see `sessions.position_id` below.

-- A team. **Placed, exactly as a profile and a skill are** — see
-- `docs/paths-and-ownership.md`. A path, a directory to file it into, named
-- exceptions, and `access::filed_where` as the only thing that decides who may
-- see one. Nothing here invents a second way to answer that.
--
-- **Not `teams`.** That table is a named group of *people* and has been since
-- `people_teams_and_paths`; this is a team of agents, and the two are different
-- nouns that happen to share a word. The product says "Agent teams" and the
-- route is `/configuration/agent-teams`, because `/configuration/teams` is
-- taken by the people.
--
-- There is no `lead_profile_id` column, deliberately. The lead *is* the root
-- position — the one with no parent — so "who leads this team" has exactly one
-- answer in exactly one place, and a lead is a position like any other: it can
-- carry instructions that apply only here, and its children are its reach.
-- `agent_team_one_lead` is what makes "exactly one root" a fact the database
-- holds rather than a rule the server remembers.
create table agent_teams (
    id            text primary key,
    org_id        text not null references organizations(id) on delete cascade,
    -- `ft_core::ResourcePath` is the only thing that writes one.
    path          ltree not null,
    created_by    text references principals(id) on delete set null,
    -- A few named people on one team, on top of where it lives. Same shape and
    -- same meaning as a profile's.
    extra_perms   jsonb not null default '{}',

    name          text not null,
    -- Unique per installation, so two people's `Platform` teams do not collide
    -- on the path's own uniqueness. A discriminator is appended at creation,
    -- exactly as a profile's and a skill's slug is.
    slug          text not null,

    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

create unique index agent_teams_by_path on agent_teams (path);
create index agent_teams_path_tree on agent_teams using gist (path);
create unique index agent_teams_slug on agent_teams (org_id, slug);
create index agent_teams_by_creator on agent_teams (created_by);

comment on table agent_teams is
  'A team of agents: a name and, through its root position, the profile that leads it. Placed, like a profile.';

-- One seat in a team's tree.
--
-- `parent_id` null is the lead. Everything else hangs off one of these, and the
-- edge is what delegation reads: an agent running in a position may hand work
-- to the profiles its **children** reference. Two positions in two teams can
-- reference one profile and have completely different children, which is the
-- whole point of the table.
--
-- `profile_id` is `on delete cascade`: deleting a profile removes the positions
-- that reference it, and — through the self-reference below — everything under
-- them. That is the honest answer, because a position whose profile is gone has
-- nothing to resolve a name against. The confirmation that names every affected
-- team before it happens is #494's; the database is what makes it true.
--
-- `parent_id` is `on delete cascade` too, so removing a position removes its
-- whole subtree. A seat with no one above it is not a seat.
--
-- `instructions` **adds, never replaces.** There is no resolution order and no
-- override semantics anywhere in this feature: a position's instructions are
-- appended to its profile's, which is why the editor's tab is Custom and not
-- Overrides. A field that looked like it could overrule a profile would be two
-- answers to "what is this agent told".
--
-- `ord` is the sibling order, explicit so it is stable — reads are
-- `ORDER BY ord, id`, and the server normalises each parent's children to
-- 0..n-1 on every write. **Deliberately not unique.** A reorder swaps two
-- values, which a unique index would refuse halfway through the statement that
-- is doing the swapping; the alternative is a deferrable constraint, which is a
-- worse trade than normalising in the one function that writes.
create table agent_team_positions (
    id            text primary key,
    team_id       text not null references agent_teams(id) on delete cascade,
    profile_id    text not null references roles(id) on delete cascade,
    parent_id     text references agent_team_positions(id) on delete cascade,
    instructions  text not null default '',
    ord           integer not null default 0,
    created_at    timestamptz not null default now()
);

-- Exactly one root per team, which is the lead.
create unique index agent_team_one_lead on agent_team_positions (team_id)
    where parent_id is null;
create index agent_team_positions_by_team on agent_team_positions (team_id, parent_id, ord);
create index agent_team_positions_by_parent on agent_team_positions (parent_id);
create index agent_team_positions_by_profile on agent_team_positions (profile_id);

comment on table agent_team_positions is
  'One seat in a team: a profile, a parent, instructions that apply only here, and a place among its siblings.';
comment on column agent_team_positions.parent_id is
  'Who this position reports to. Null for the lead, of which there is exactly one per team.';
comment on column agent_team_positions.instructions is
  'Extra instructions for this seat only, appended to the profile''s. Never a replacement for one.';

-- Which position a session occupies, when it occupies one.
--
-- **This is the column everything else in the nine-issue effort rides on, and
-- the one that is painful to retrofit.** A session already says which profile
-- it runs (`profile_id`) and which session started it (`parent_id`); neither
-- can say *where in a team* it is standing, and without that an agent's reach
-- is a property of its profile again.
--
-- Inherited down the lineage: a person starts a session as a team and it
-- occupies that team's lead position; the lead spawns a child from one of its
-- position's children, and the child occupies **that** position. So the chain
-- of sessions walks the chain of positions, and a delegation chain cannot be
-- deeper than the tree is — which is what makes the depth limit on the tree the
-- only bound delegation needs.
--
-- **Null is what every session today is**, and null means the old path: a
-- Manager profile's `delegate_scope`, intersected with what its owner can see.
-- Nothing is backfilled, because there is nothing to backfill from — no team
-- exists yet. #491 is the ticket that seeds teams from what profiles have
-- actually spawned.
--
-- `on delete set null` rather than cascade, for the reason `profile_id` has it:
-- deleting a team must not take the sessions running under it. A session whose
-- position has gone keeps going, it just stops being able to say where it
-- stood — and falls back to the old path, which for a profile that is not a
-- Manager is a refusal that says why.
alter table sessions
    add column position_id text references agent_team_positions(id) on delete set null;

create index sessions_by_position on sessions (position_id) where position_id is not null;

comment on column sessions.position_id is
  'The position in an agent team this session occupies, when it occupies one. Inherited from its lead''s position at spawn. Null is a session with no team, which delegates the old way or not at all.';
