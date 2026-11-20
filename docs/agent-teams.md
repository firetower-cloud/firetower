# Agent teams

**Status:** built, first slice — the expand half of an expand/contract.
`20261120130000_agent_teams.sql`, `20261120140000_agent_team_seeding.sql`,
`crates/ft-server/src/agent_teams.rs` and `agent_teams/{seed,window}.rs`,
`crates/ft-server/src/api/agent_teams.rs`, and the position-aware halves of
`crates/ft-server/src/delegate.rs` and `api/sessions.rs`.

Behind one flag for the compatibility window's duration —
`FIRETOWER_AGENT_TEAMS`, on unless it is set to `off`. See
[the window](#the-compatibility-window).

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
  one level down. **The database holds this one too** —
  `agent_team_one_profile_per_parent`, a partial unique index on
  `(parent_id, profile_id)` — because a check in the server is a check with a
  gap after it, and the compatibility window's insert raced that gap: two
  spawns naming one profile at the same moment both saw no seat and both added
  one. What that produced was worse than a duplicate row, since the team could
  then be neither saved nor spawned into by name. The constraint belongs to
  this rule and landed with #491 because branches were stacked on this one.

  One cost, and it is the index's: two existing seats under one position
  cannot **trade** profiles in a single save, because the updates go one
  statement at a time and the first half of a swap collides with the second
  half before it has moved. The save is refused with a sentence that says to
  remove one of the two, save, and add it back with the other's profile —
  which works where "change one and then the other" does not.

`GET /api/v1/agent-teams/limits` reports both, so an editor can refuse a
twelfth level where it was drawn.

## Where the teams came from

Nobody drew the teams that exist on the morning after the upgrade. They were
**seeded from what each profile had actually spawned**, read out of session
lineage: a session running profile P, a child session of it running profile Q,
is one position — Q reporting to P.

That is the only non-arbitrary materialisation available. A profile used to
carry its own list of profiles it could hand work to, and the default for that
list was empty, which meant *anything the owner can see, including profiles
created later*. **That default cannot become a tree** — it is not a set of
rows, it is a standing subscription to a set. A snapshot of everything visible
would have handed somebody a fourteen-seat team on day one for a profile that
only ever used three, and every one of those seats would be something nobody
chose.

Reading history has the property the deprecation needs instead: **anybody
whose patterns continue sees no change at all.**

| | |
| --- | --- |
| Which profiles get a team | every one with `can_delegate`, named after itself |
| What a team holds | the profiles it has spawned, most recently first |
| How deep | **one level**, because a delegated child cannot spawn today, so no deeper lineage exists to read |
| A profile that never spawned | an **empty** team — a name, a lead, nothing under it. Not a missing one: the team is where reach is authored now |
| A profile that cannot delegate | no team. It had no reach to preserve |
| A profile that only spawned *itself* | an empty team. A profile may not report to itself, so seeding that would make a team nobody could save |
| More than 64 spawned | the **63 most recently spawned**, with the rest left out and said in the log. Refusing the team would cost the profile all of its reach; raising the limit for migrated teams would make the limit a suggestion |
| Where the team is filed | wherever its lead profile is filed, so exactly the people who can use the profile can see the team |

Past 64, the 63 most recently spawned come across — the lead takes the
sixty-fourth seat — and the rest are named in the log rather than dropped
silently.

`roles.delegate_scope` is deliberately not read: a profile that never spawned
gets an empty team even when somebody had narrowed its scope, because a scope
that was never exercised is a guess about intent the same way a visibility
snapshot is. The scope is not lost — it is exactly what the window below
admits from.

The cut happens **once per installation**, recorded in `agent_team_seeding`:
how many teams, how many positions, and when. A team deleted afterwards stays
deleted, because a migration that keeps re-asserting itself is worse than one
that was wrong once.

## The compatibility window

Seeding reads what a profile has done, which is still a guess. Somebody whose
Manager handed work to a Reviewer once a quarter has a team with no Reviewer in
it, and the first time that quarter comes round their setup would refuse — a
break caused by a migration they did not ask for.

So for **30 days after that installation's own cut**, a spawn of a profile a
*seeded* team does not hold **succeeds and adds it**. Teams converge on real
use rather than on a reading of history.

A learning phase grows a team without anybody choosing, which *is* the
unbounded reach this work removes, only slower. Four properties are what make
it a migration aid rather than a reprieve:

1. **It never grants reach the old path did not already grant.** What it
   admits from is that session's own old answer — the profile's
   `delegate_scope` intersected with what its owner can see, for a session a
   person started whose profile is a Manager. Not "any profile".
2. **Every seat it adds is marked**, with the time: `auto_added_at` on the
   position, and a count on the team so a list row can say *2 added
   automatically*. **Saving the team clears the marks**, which is what
   reviewing one means — a save carries the whole tree, with the whole tree on
   screen. There is deliberately no accept-this-seat endpoint.
3. **Only a team nobody drew learns.** `agent_teams.seeded_at` is the
   condition. A team authored after the cut is exactly what was authored, from
   its first spawn onwards.
4. **It closes.** `agent_teams::window::WINDOW_DAYS`, measured from
   `agent_team_seeding.seeded_at` rather than from a date in the binary, so an
   installation that upgrades late gets a whole window instead of one that
   expired before it arrived.

Where it does **not** reach, each being the old path's own boundary rather
than a new rule: a delegated child (which could never spawn at all), a seat
below the lead, a profile that was not a Manager, and a team somebody drew.

Past the limit the refusal names the number and the screen. Past the window
the refusal is the ordinary not-found, unchanged — out of reach reads as *does
not exist* and lists what does report there. It says nothing about the window:
an agent cannot act on a date, and naming a mechanism that has closed would
send it looking for a way back in.

**The flag.** `FIRETOWER_AGENT_TEAMS=off` turns the whole feature off for the
window's duration — as do `0`, `no`, `false` and **an empty value**, which are
`ft_cli`'s falsey spellings rather than a set invented here. Setting the
variable to nothing is somebody turning something off, so it reads that way;
leaving it unset is not, and leaves the feature on. What off does: no team is visible, no session is standing anywhere, and
every session delegates by its profile's own reach — which still works,
because this is the expand half and nothing has been dropped. It is the way
*out* of a feature that has gone wrong, not the way in, which is why the
default is on: a deprecation meant to be silent cannot be opt-in. It goes with
#497.

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

- **The Agent teams screen and the map** (#492), and **the profile drawer**
  (#494). The map is where an auto-added seat is *drawn* as marked: the server
  reports `autoAddedAt` on the position and a count on the team, and nothing
  yet draws either.
- **Starting work as a team from the composer, and scheduling one** (#493). A
  schedule that names a team has to pin the whole tree at approval; today an
  approved run is composed the way an unteamed profile is, so nothing can
  quietly acquire a reach nobody approved.
- **Read-only on mobile** (#495) and **YAML import and export** (#496).
- **Dropping the old per-profile reach** (#497), which is the contract half.
