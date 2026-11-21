# Agent teams

**Status:** built, first slice. `20261121120000_agent_teams.sql`,
`crates/ft-server/src/agent_teams.rs`, `crates/ft-server/src/api/agent_teams.rs`,
the `create_team` / `update_team` / `list_teams` / `get_team` tools in
`crates/ft-worker/src/approver.rs`, and `desktop/src/ui/config/AgentTeams.tsx`.

A profile used to carry who it hands work to, in `roles.delegate_scope`. That
made teams exist in effect without existing as a thing, and it cost four
specific things:

* **You could not see who was capable of what.** The edges lived inside each
  manager's edit card, one profile at a time, and there was no view of the
  whole.
* **A profile's children travelled with it.** Reach was a property of the
  profile, so adding a profile that leads a team elsewhere brought that team
  along. *"Bare here, three reports there"* could not be expressed at all.
* **Delegation was one level deep.** A child could not spawn, because it had
  nowhere to stand.
* **The default was unbounded.** An empty `delegate_scope` meant *anything the
  owner can see*, including profiles created later — so two profiles at their
  defaults reached each other.

So identity and structure came apart.

## Two objects

A **profile** is identity only: its name, what it does, its instructions, its
skills, and how it runs. It has no reach, no children, and no
manager/operator distinction. Any profile can lead.

A **team** is a name and a tree of **positions**. A position references a
profile, sits under exactly one other position, and may add instructions that
apply only there. The team's **lead** is its root position — the one with no
parent — and `agent_teams_one_lead` makes it exactly one.

The Designer in two teams is two positions referencing one profile, with
different children in each, because the team says so and the profile says
nothing. The same profile may hold **two positions under one parent** — an
Engineer on the web client and an Engineer on the API — and their extra
instructions are what tell them apart, on the map and in the sentence a `spawn`
reads back.

## What decides whether a `spawn` is refused

The children of the position the session occupies. Nothing else.

`sessions.position_id` says where a session stands. A child is started standing
on the position it was spawned into, which is how a team gets depth: the old
model could only ever be one level deep because a child had nowhere to stand.
`delegate::reach_of` is the one place this is resolved, and
`sessions::persona_for` composes the prompt from the same tree — so a profile
that is not under this position is not named in the prompt and is refused by
name if the agent asks for it anyway.

Three refusals are their own sentences rather than "no subagent called that":

* **Naming your own lead** — it is who you report to, not somebody you can hand
  work to.
* **Naming yourself** — a position cannot hand work to itself.
* **A session with no position** — it does the work itself, and the refusal
  says where to make a team.

## Starting one

You never talk to a team. You talk to its lead, with the team behind it. So
`NewSession.team` names a team and the server resolves its lead; naming a
profile that is not that lead is refused rather than quietly overridden,
because the two readings differ in whether seven other agents can start.

The composer's picker groups **teams above profiles**, each row naming its lead
and its size. A profile that leads a team appears twice — once bare, once as
the team — and the sentence under the box says which:

> Starts Engineering Manager, Product's lead. It can hand work to 7 other
> agents in the team.

against

> Starts Engineering Manager on its own. It cannot hand work to anybody.

A **position is never selectable**. A position only means something inside its
tree.

## Schedules

A schedule that names a team **pins the whole tree at approval**, and editing
the team clears the approval so the next run is refused until somebody looks.
Neither half is new: `profile_fingerprint` already pinned the profile's
composed persona for exactly this reason, and the team's shape — every
position's profile, parent, order and extra instructions — is now hashed into
it. A team id resolved at run time would be the same mistake with a larger
blast radius.

The consequence to surface: **editing a team that four schedules use pauses
four schedules.** The map says how many before Save.

## The map

`/configuration/agent-teams`, and `/configuration/agent-teams/<id>` for one
team. Never `/configuration/teams` — that is teams of *people*.

Hybrid layout: the lead's children spread horizontally beneath it with elbow
connectors, and everything below that indents. Measured on the prototype's
hardest lane, a classic organigramme throughout is 4640px wide and the hybrid
is 504px and complete. The maths is in `desktop/src/ui/config/teams/layout.ts`
and is tested as numbers.

**The map writes a draft. Save is the only commit.** Adding, removing, moving
and telling all show as pending, and Discard restores the whole state including
a removed subtree — which is why the remove control has no confirmation dialog:
the undo is on screen the whole time, and the control's own label states the
count before it is pressed. Save sends the whole tree as one `PUT`, so a team
is never half-written and a position sent back by its id keeps its row, and the
sessions standing on it.

One card belongs to exactly one team. There are no cross-team edges and no
borrowed cards.

## Deleting

Deleting a **team** takes its positions and leaves every profile alone.

Deleting a **profile** that a team stands on is refused, and the refusal names
the teams and the count. `team_positions.role_id` is `on delete restrict`, so
the database would refuse it anyway; `api::roles::delete_role` is what makes
the refusal readable.

## Limits

A team holds at most **50 positions** and goes at most **6 levels** deep
(`agent_teams::MAX_POSITIONS`, `MAX_DEPTH`). Generous enough never to bite
ordinary use, and stated rather than left to whoever reads the recursion first:
with no spend cap in this scope these are the only guardrail there is.

**There is still no spend cap.** A scheduled team run can start many agents
unattended with nothing to interrupt it. The schedule screen's sentence is the
only thing standing between a team schedule and a surprise.

## The compatibility window

`roles.can_delegate` and `roles.delegate_scope` are **deprecated and still
read**. Nothing writes them any more:

* the profile editor has no delegation controls, and shows a deprecation notice
  on a profile that still carries the old reach;
* `create_profile` and `update_profile` **refuse** `can_delegate`,
  `delegate_scope` and `delegates_to` by name, pointing at `create_team`;
* `list_profiles` no longer marks a profile a Manager, and `get_profile`
  reports which teams hold it instead.

They are still read because a session that started before the cut has to finish
normally, and because an installation that upgraded this morning must not find
its agents mute this afternoon. A session **with** a position resolves from its
team; a session **without** one falls back to the old reach, and the interface
says so on the profile itself. Both halves go when the columns do —
`delegate::reach_of` and the `else if profile.can_delegate` branch of
`sessions::persona_for`.

## The MCP tools

| Tool | Does |
| --- | --- |
| `create_team` | Draws a team: a `lead` by name, and `members`, each a profile with an optional `under` and `extra_instructions`. A `key` is only needed when one profile holds two positions. |
| `update_team` | Redraws one, **whole**: `members` is who is in the team after the call, so anybody left out is taken out. A call without `members` is refused rather than emptying one. |
| `list_teams` | Each team's name, lead, size and depth. |
| `get_team` | One team whole, enough to redraw it. |

**There is no `delete_team`.** An agent may draw a team and redraw one; it may
not take one away. That is the asymmetry `propose_schedule` already keeps, and
it is sharper here: deleting a team silently mutes every lead standing in it.

## Not yet

Each of these is a smaller change on top of what is here, and each is
deliberately out of this slice rather than forgotten.

- **YAML import and export.** The file format is decided — `teams/<name>.yaml`,
  a `name`, a `lead` and nested `positions` — and the API is already
  declarative in exactly the way the file is, so `plan` and `apply` sit on top
  of `AgentTeams::replace` without changing it.
- **Seeding from session lineage.** Migration writes no teams: an installation
  upgrading keeps working on the old reach and draws its teams when it wants
  them. Seeding every delegating profile a team named after it, from what it
  has actually spawned, is a job that can run later against the same API.
- **Skills on the map**, as a per-view switch drawing grey chips inside a card.
- **Mobile.** Read-only, a list of teams and their members. The composer's
  picker on mobile does not yet carry the two groups.
- **Drag to reorder siblings.** The ordinal is authoritative and preserved;
  nothing on the map writes it except appending.
- **A spend guardrail.** Named in the specification as an unresolved risk, and
  still one.
