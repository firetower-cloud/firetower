# Agent teams

**Status:** built, first slice — the expand half of an expand/contract.
`20261120130000_agent_teams.sql`, `crates/ft-server/src/agent_teams.rs`,
`crates/ft-server/src/api/agent_teams.rs`, and the position-aware halves of
`crates/ft-server/src/delegate.rs` and `api/sessions.rs`. Starting work as one
and scheduling one are in the composer's picker
(`desktop/src/ui/StartComposer.tsx`, `mobile/src/ui/ProfileSheet.tsx`) and in
`api/schedules.rs`.

An **agent team** is a name and the profile that leads it. It holds a tree of
**positions**; a position references a profile, reports to another position,
carries instructions that apply only there, and has an explicit place among its
siblings. An agent running in a position may hand work to the profiles its
children reference, and to nothing else.

> "Team" already means *a group of people* in Firetower — see
> [teams and directories](./teams-and-directories.md). This is a team of
> agents. The two are different nouns that share a word, the tables are
> `teams` and `agent_teams`, and the route is `/configuration/agent-teams`
> because `/configuration/teams` is the people's.

## Why it is not on the profile

A profile used to carry the list of profiles it could hand work to, and a flag
for whether it could hand work off at all. That is what this replaces, and the
reason is one sentence:

**Reach is a property of a relationship, not of an agent.**

The same Designer should be able to have three reports in one team and none in
another. With the list bolted onto the profile row, that sentence cannot be
expressed at all — a profile's children travelled with it everywhere it was
named, nothing could show who was capable of what, delegation was one level
deep, and the default reach was *everything the owner can see*.

So a profile is now identity only: its name, what it does, its instructions,
its skills, how it runs. No reach, no children, no manager/operator
distinction. Where it sits is a position.

Two consequences worth stating out loud:

- Two positions in two teams can reference **one** profile and have completely
  different children and completely different extra instructions, with
  identical name, description, instructions and skills.
- Adding a profile that leads another team creates a position with **no
  children**. Nothing comes with it, and the other team is unchanged.

## A position adds; it never replaces

A position's instructions are appended to its profile's. There is no resolution
order and no override semantics anywhere in this feature, which is why the
drawer's tab is *Custom* and not *Overrides*. A field that looked like it could
overrule a profile would be two answers to "what is this agent told".

## A team is Placed

Filed, shared and permissioned **exactly as a profile or a skill is** — a path,
a directory, named exceptions. `access::filed_where` is the only thing that
decides who may see one; nothing here invents a second access model. See
[paths and ownership](./paths-and-ownership.md).

That predicate is applied **twice**, and the second time is the load-bearing
one: composing a lead's prompt and resolving a name at spawn both intersect the
position's children with the profiles the owner can actually see. A seat
referencing a profile its owner cannot reach is not a report. It is the same
intersection the old per-profile reach made, in the same place, for the same
reason.

A seat whose profile the *reader* cannot see still appears in the map, without
its name: the shape of the tree belongs to the team, which they may see, and
the profile's name belongs to the profile, which they may not.

## Where a session stands

```
sessions.position_id → agent_team_positions(id) on delete set null
```

This is the edge everything hangs off, and it is **inherited down the lineage**:

- A person starts work as a team — `team` on `POST /api/v1/sessions` — and the
  session stands in that team's **lead** position. Because the lead is a
  profile, naming the team names the profile too; naming a team and a different
  profile is refused rather than answered either way.
- A lead hands work to one of its reports, and the child stands in **that**
  seat. So the chain of sessions walks the chain of positions.
- A one-off — a `spawn` with a `goal` and no `role` — names no seat. It is a
  leaf and cannot hand work on, which is what every delegated child is today.

Nothing is inferred. A profile that happens to lead a team does not pick that
team up by being named on its own: **you never talk to a team, you talk to its
lead, with its team behind it**, and a profile started bare has no reach. That
distinction is what the composer's picker has to carry.

A position that has gone — the team deleted, or filed somewhere its owner can
no longer reach — resolves to nothing, and the session falls back to the old
path. Fail closed, every time: the alternative is an agent keeping a reach into
a team that has been taken away from it.

## Starting work as one

**You never talk to a team. You talk to its lead, with its team behind it.**
The composer's picker is where that is either made plain or papered over, so:

- A team is a row, **banded above the profiles**. That is not a new
  preference: the picker already floated the delegating profiles to the top,
  and reach has moved onto the team, so the position moves with it.
- A team row **names its lead and its size before it is picked**. If the
  picker says *Growth* and the conversation opens with the Orchestrator, the
  row misled somebody about the one thing it was for.
- A profile that leads a team **appears twice**, once bare and once as the
  team, and that is deliberate. The two start completely different things —
  one agent that cannot delegate at all, against that same profile with its
  reports reachable — and one row standing for both outcomes would leave
  nothing on screen saying which you were about to get.
- A team and a profile that share a name, which is common because a team is
  often named after what its lead does, are told apart by the group labels.
  Neither is renamed.
- **A position is never selectable.** A position only means something inside
  its tree. The picker is built from the team list and the profile list and
  from nothing else.
- The sentence under the list says the consequence: *Starts Engineering
  Manager, Product's lead. It can hand work to 7 other agents in the team*
  against *Starts Engineering Manager on its own. It cannot hand work to
  anybody.* A Manager profile whose older per-profile reach is still live gets
  its own clause rather than a sentence that is false of it; that clause goes
  with `roles.can_delegate` in #497.

The same picker, the same bands and the same counts are on the phone. Starting
work is within what mobile may do, and the one-agent-or-eight difference is
*harder* on a small screen, not easier.

A team with **no lead** — its lead's profile was deleted — and one whose lead
is a profile the person cannot reach are both shown and both refused, with the
reason on the row. Either would fail at the launch instead.

## Scheduling one

A schedule names a team on `POST /api/v1/schedules` and every run stands in
that team's lead seat. **The whole tree is pinned at approval**, not resolved
at run time, and that is the rule a profile's revision already follows: a
schedule is an authorization over a particular text, and an edit must not be
able to change what an unattended run does. For a team the argument is
sharper — a seat added to a team would silently widen what an approved run may
hand work to, which is the same mistake with a larger blast radius.

So `pins.team` holds the tree, the lead's seat, the team's name and size, and
a fingerprint of the shape; `pins.persona` is the lead's prompt composed *in
that seat*, because the reach is stated in the prompt as well as enforced at
the spawn.

**Editing the team clears the approval.** Both easy answers to what an edit
should do are wrong: silently keeping the old shape means a fix never reaches
the schedule, and silently adopting the new one is exactly what approval
exists to prevent. So both halves happen and neither is silent — the pins
become the tree as it is now, and the schedule stops with
`paused_reason = 'team_changed'`, which reads as *Waiting for you* rather than
as something somebody paused. Turning it back on is the look.

A team whose **lead** changed is not adopted. The lead decides the engine, and
the engine decides whether the pinned permission mode and sandbox are even
words, so a new lead carries settings approved for something else — which is a
whole `pins_for` rather than a re-pin. The pins stay, the approval still goes,
and approving again is refused with a sentence that sends somebody to the
schedule.

The launch gate recomputes the fingerprint anyway, which is the half an edit
hook cannot do: a team can change shape without anybody editing it — deleting
a profile cascades onto its seats, deleting the team takes the lot, filing it
away makes it unreadable to the run — and none of those pass through the
editor.

**And the editor says how many schedules a save would stop, before Save.**
`AgentTeam.schedules` counts the approved schedules pinning the team, on the
same read the map already makes to draw its tree, so editing a team that four
schedules pin says *four* before the press rather than after.

An agent proposing a schedule may **not** name a team. A profile is identity;
a team is a reach, and a proposal that named one would be an agent writing
down an authorization for several more agents to run unattended. That is the
person's to say, which is the propose-but-not-activate rule one level further
in.

## Limits

Two, and they are deliberately the only structural guardrail delegation has.
There is no money cap and no wall-clock cap in this work — `docs/delegation.md`
is candid about that — and arbitrary-depth delegation with no bound at all was
not acceptable.

| | |
| --- | --- |
| **Depth** | 6 levels, counting the lead. `agent_teams::MAX_DEPTH`. |
| **Positions** | 64 per team, the lead included. `agent_teams::MAX_POSITIONS`. |

A session's position descends exactly one level per hand-off, so **the depth of
the tree is the length of the longest chain of agents**. That is why there is no
second rule about how deep a `spawn` may go: the limit on the shape is the limit
on the recursion, and there is nothing to keep in step.

Two more structural rules, enforced where somebody can still see what they drew
rather than at a spawn that cannot be answered:

- **A profile may not report to itself**, however far up. Two seats of one
  profile in different branches stay legal — that is what per-position
  instructions are for.
- **One profile at most once among one position's children.** A lead hands work
  off by name, so two sibling seats of one profile would be a name that does
  not say which is meant. The same rule profile names get within a directory,
  one level down.

`GET /api/v1/agent-teams/limits` reports both, so an editor can refuse a
twelfth level where it was drawn.

## The two paths, during the window

Nothing is removed yet. Both of these work:

| The session | Its reach |
| --- | --- |
| holds a position | that position's children ∩ what the owner can see |
| holds none, and its profile is a Manager | the profile's `delegate_scope` ∩ what the owner can see, and a child cannot spawn |
| holds none, and its profile is not | nothing, and the refusal says so |

A session that holds no position behaves **exactly** as it did before this
landed, including the flat rule. Dropping the old columns is #497, after the
compatibility window.

### What each refusal says

An agent reads these and acts on them, so each one names a fix rather than a
rule:

- *No team, not a Manager.* "This session holds no position in an agent team
  and its profile is not a Manager, so there is nobody for it to hand work to.
  Reach comes from a team…" Both reasons, because both are live during the
  window and a sentence naming one would send somebody to the wrong screen.
- *A position with nothing under it.* "Nothing reports to your position in the
  "Platform" team, so this work is yours to do rather than hand on." The prompt
  says the same thing up front, so a turn is not spent finding out.
- *Naming its own lead.* "…is the position above yours in the "Platform" team —
  your own lead. Work goes down the tree, not back up: finish your turn and
  what you say is delivered to it." Its own sentence, because the generic
  not-found would tell an agent a profile does not exist when it is the one it
  reports to.
- *A profile with no seat here.* The ordinary not-found, listing the ones that
  do report here. Out of reach reads as *does not exist* rather than as *not
  allowed*, which is the rule the old path already followed.

## Where things are written down

| | |
| --- | --- |
| `agent_teams` | a team: a path, a name, a slug, exceptions |
| `agent_team_positions` | one seat: a profile, a parent, instructions, `ord` |
| `agent_team_one_lead` | exactly one root per team, which is the lead |
| `sessions.position_id` | where a session stands |

`ord` is explicit so sibling order is stable, and **not unique**: a reorder
swaps two values, which a unique index would refuse halfway through the
statement doing the swapping. The server normalises each parent's children to
0..n-1 on every write, in one function, and reads are `ORDER BY ord, id`.

## The write is a whole tree

`PUT /api/v1/agent-teams/{id}` takes the team's name and its lead, with the
tree nested beneath it: the parent is the nesting and the sibling order is the
array, so no client has to mint an id to express a shape. **Save is the only
commit**, which is why there is no add-a-position endpoint and no reorder
endpoint — a tree is one object.

A position may carry its existing `id`, and then it is **updated in place**.
That is what keeps `sessions.position_id` pointing at something when somebody
saves a team an agent is running in. The exception is a change of lead: a root
carrying a different id re-mints the whole tree, because a team with a
different lead is not the same tree.

An id that is not this team's is refused rather than ignored.

## Trying it

```sh
just db && just dev
```

A team is the control plane's, so this needs no worker to exercise the shape:

```sh
# Two profiles, then a team where one reports to the other.
curl -sX POST localhost:4400/api/v1/roles -H 'content-type: application/json' \
  -b cookies -d '{"name":"Orchestrator","does":"Breaks work up","placement":"here"}'
curl -sX POST localhost:4400/api/v1/roles -H 'content-type: application/json' \
  -b cookies -d '{"name":"Engineer","does":"Writes the change","placement":"here"}'
curl -sX POST localhost:4400/api/v1/agent-teams -H 'content-type: application/json' \
  -b cookies -d '{"name":"Platform","lead":{"profile":"<orchestrator>",
                  "children":[{"profile":"<engineer>",
                               "instructions":"In Platform, the console only."}]}}'
```

Then start a workspace with `"team": "<team id>"` on `POST /api/v1/sessions`
and ask the agent to hand the work to the Engineer. `GET
/api/v1/sessions/{id}/persona` is what it was told; the refusals above are what
it gets if it names anything else.

## Not yet

Each of these is its own ticket, and this one is what they are blocked on.

- **Teams seeded from what profiles have actually spawned** (#491), so nobody
  rebuilds by hand what they already had.
- **The Agent teams screen and the map** (#492), and **the profile drawer**
  (#494). The map is also where the *this pauses four schedules* notice is
  mounted — the count is on `AgentTeam.schedules` and the notice itself is
  `desktop/src/ui/schedules/Pinned.tsx`, so it is one import.
- **Read-only on mobile** (#495) and **YAML import and export** (#496).
  Starting work as a team is already on the phone; #495 is the teams *screen*.
- **Dropping the old per-profile reach** (#497), which is the contract half.
  The picker's third sentence — a Manager profile that still hands work out
  through its own settings — goes with it.
