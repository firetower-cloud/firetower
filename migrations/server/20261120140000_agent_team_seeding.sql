-- Seeding teams from session lineage, and the window that follows it.
--
-- `20261120130000_agent_teams.sql` built the shape. This is the part that has
-- to answer a harder question: **what do the teams contain on the morning
-- after the upgrade?**
--
-- A profile used to carry its own list of profiles it could hand work to, and
-- the default for that list was *empty*, which meant **anything the owner can
-- see — including profiles created later**. That default cannot be copied
-- across. It is not a set; it is a standing subscription to a set, and a tree
-- has to hold rows. A snapshot of everything visible would hand somebody a
-- fourteen-position team on day one for a profile that only ever used three,
-- and every one of those positions would be a thing nobody chose.
--
-- So the materialisation is read from **what the profile actually spawned**,
-- out of `sessions.parent_id` — the edge `20261028120000_lineage.sql` added.
-- A lead session running profile P, a child session of it running profile Q:
-- that is one position, Q reporting to P. It is the only non-arbitrary answer
-- available, and it has the property the product needs — **anyone whose
-- patterns continue sees no change at all**, because the team already holds
-- what they have been doing.
--
-- Every seeded team is **one level deep**, because a delegated child cannot
-- spawn today (`docs/delegation.md`, Limits) so no deeper lineage exists to
-- read. A profile that never spawned anything gets an **empty team** — a name
-- and a lead and nothing under it — not a missing one: the team is where its
-- reach is authored now, and having to create one by hand before authoring
-- anything would be the break this is here to avoid.
--
-- The seeding itself is `crates/ft-server/src/agent_teams/seed.rs` rather than
-- a `DO` block here, for three reasons that each matter: ids are ULIDs minted
-- by `ft_core`, paths are built by `ResourcePath` and nothing else is allowed
-- to write one, and the limits in `agent_teams::check` are a Rust function
-- with unit tests. A second implementation of any of those in plpgsql would
-- be a second answer to a question that already has one. What this migration
-- does is add the three columns that make the seeding legible afterwards, and
-- the row that records it happened.

-- **A team nobody drew.** Null is a team somebody authored; a timestamp is a
-- team this effort materialised out of lineage.
--
-- Kept rather than discarded once the seeding is done, and it carries weight
-- in two places:
--
--   * The screen (#492) can say *seeded from what this profile spawned —
--     review it* on a team that was never drawn, which is the difference
--     between a migration somebody can audit and a migration that quietly
--     asserts it knew best.
--   * **The compatibility window applies to these teams and to no others.**
--     The window exists to repair a gap left by a migration nobody asked for;
--     a team somebody drew after the cut has no such gap, and growing it
--     behind their back would be the unbounded reach this whole effort
--     removes. See `agent_teams/window.rs`.
alter table agent_teams add column seeded_at timestamptz;

create index agent_teams_seeded on agent_teams (seeded_at) where seeded_at is not null;

comment on column agent_teams.seeded_at is
  'When this team was materialised from session lineage, if it was. Null is a team somebody authored. Only a seeded team learns during the compatibility window.';

-- **A seat nobody chose**, added by a spawn during the compatibility window.
--
-- This column is the mitigation, and without it this work has shipped the old
-- open-ended behaviour with extra steps. A learning phase that grows a team on
-- real use is the only way the deprecation is silent — but it grows the team
-- without anybody deciding, which is exactly the reach being removed, only
-- slower. The answer is not to refuse the growth; it is to make every inch of
-- it **visible and reviewable**:
--
--   * `agent_teams` carries a count of these, so a list row can say *2 added
--     automatically* without reading the tree.
--   * The position reports it on the wire, so the map can mark the seat.
--   * **Saving the team clears it.** A save sends the whole tree with the
--     whole tree on screen, so keeping a marked seat through one is a person
--     choosing it — that is the review, and it needs no endpoint of its own.
--
-- Null is a seat a person put there. A timestamp is one the window added, and
-- it says when.
alter table agent_team_positions add column auto_added_at timestamptz;

create index agent_team_positions_auto_added on agent_team_positions (team_id)
    where auto_added_at is not null;

comment on column agent_team_positions.auto_added_at is
  'When the compatibility window added this seat, if it did. Null is a seat a person chose. Cleared when somebody saves the team, which is what reviewing one means.';

-- That the cut happened, when, and what it produced.
--
-- One row per organisation, written by the seeder in the same transaction as
-- the teams it made. Three jobs:
--
--   * **It is the idempotency.** The seeder runs at start-up, and start-up
--     happens again. Without this row, somebody who deleted a seeded team
--     would find it back after the next restart — a migration that keeps
--     re-asserting itself, which is worse than one that was wrong once.
--   * **It is the clock.** The window closes `seeded_at` plus
--     `window::WINDOW`, so an installation that upgrades six months late gets
--     its own full window rather than one that expired before it arrived. A
--     hard-coded date in the binary would have been the other thing, and the
--     other thing is wrong.
--   * **It is the record.** How many teams and how many positions the cut
--     produced, so the question "what did this do to my installation" has an
--     answer that is not a log line somebody has to still have.
--
-- `teams`/`positions` are what was written, not a live count: a team deleted
-- afterwards does not retract the fact that the seeding made it.
create table agent_team_seeding (
    org_id     text primary key references organizations(id) on delete cascade,
    seeded_at  timestamptz not null default now(),
    teams      integer not null default 0,
    positions  integer not null default 0
);

comment on table agent_team_seeding is
  'That teams were seeded from session lineage for this organisation, when, and how many. The row is the idempotency and the start of the compatibility window.';
comment on column agent_team_seeding.seeded_at is
  'When the cut happened. The compatibility window runs from here, so an installation that upgrades late still gets a whole one.';

-- **One profile at most once among one position's children**, held by the
-- database rather than only by the server.
--
-- **The rule is #490's, not #491's.** `docs/agent-teams.md` states it there —
-- *a lead hands work off by name, so two sibling seats of one profile would be
-- a name that does not say which is meant* — and `agent_teams::check` enforces
-- it on every write. What was missing is a constraint, and the compatibility
-- window above is what found that out: its insert read `WHERE NOT EXISTS` and
-- then wrote, which is two statements' worth of racing in one. **Two spawns
-- naming the same profile at the same moment both saw no seat and both added
-- one** — and a lead dispatching two children at once is the ordinary shape of
-- parallel work, so it is likeliest exactly when the window is doing its job.
--
-- The state that produced is worse than a duplicate row. `check` forbids it, so
-- the team can no longer be **saved**; and the profile can no longer be
-- **spawned by name**, because the name does not say which seat is meant. A
-- race during the window could brick delegation to a profile and lock editing
-- of the team holding it, with nothing to say why.
--
-- So the invariant moves to where no interleaving can get past it. A
-- check-then-write cannot be made safe by widening the transaction or by
-- retrying; it is made safe by the database refusing the second write.
--
-- **Partial, and that is load-bearing.** A lead's `parent_id` is null, and a
-- unique index treats nulls as distinct — so an unqualified index would not
-- constrain leads at all and the `where` clause only says so out loud. Leads
-- are already covered, and better: `agent_team_one_lead` allows exactly one per
-- team.
--
-- **It is in #491's migration because of the stacking, not because it belongs
-- here.** Three branches now sit on `agent/team-management-eng-teams`;
-- amending its schema underneath them would invalidate work in flight, which
-- is a worse trade than an index one file further down the ordering. The two
-- have no functional dependency — this constrains a table that one created —
-- so only the order has to be distinct.
--
-- Nothing can already violate it: `agent_team_positions` is new in this
-- unreleased effort and `check` has refused the shape since the table existed,
-- so there is no installation whose rows this could fail to apply against.
--
-- One cost, named rather than discovered: two existing seats under one parent
-- can no longer **trade** profiles in a single save. `write_tree` updates kept
-- rows one statement at a time, so the first half of a swap collides with the
-- second half before it has moved. The final tree is legal and the save is
-- refused anyway — `AgentTeams::write` turns that collision into a sentence
-- rather than a 500, and says to do it in two steps.
create unique index agent_team_one_profile_per_parent
    on agent_team_positions (parent_id, profile_id)
    where parent_id is not null;

comment on index agent_team_one_profile_per_parent is
  'One profile at most once among one position''s children, so a lead handing work off by name always names one seat. #490''s rule; the constraint landed with #491 because branches were stacked on it.';
