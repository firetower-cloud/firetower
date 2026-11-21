# Agent teams

**Status:** built, first slice — the expand half of an expand/contract.
`20261120130000_agent_teams.sql`, `20261120140000_agent_team_seeding.sql`,
`crates/ft-server/src/agent_teams.rs` and `agent_teams/{seed,window}.rs`,
`crates/ft-server/src/api/agent_teams.rs`, and the position-aware halves of
`crates/ft-server/src/delegate.rs` and `api/sessions.rs`. Starting work as one
and scheduling one are in the composer's picker
(`desktop/src/ui/StartComposer.tsx`, `mobile/src/ui/ProfileSheet.tsx`) and in
`api/schedules.rs`.

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

## Starting work as one

**You never talk to a team. You talk to its lead, with its team behind it.**
The composer's picker is where that is either made plain or papered over, so:

- A team is a row, **banded above the profiles**. That is not a new
  preference: the picker already floated the delegating profiles to the top,
  and reach has moved onto the team, so the position moves with it. **Among
  the profiles that sort survives for as long as the old reach does** — a
  Manager started bare still hands work out during the window, which is the
  same fact that earns it a chip and its own sentence, and three things saying
  *this one delegates* beside a sort saying nothing would be one of them
  wrong. An install with no teams therefore sees the picker it saw before.
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
- **The number in that sentence is `AgentTeam.reports`, not
  `AgentTeam.positions`.** Reach descends exactly one level per hand-off, and
  a seat whose profile this person cannot see is not a report at all, so the
  size of the tree overstates what picking the row gets you in two independent
  ways — a seven-seat team whose lead has two reachable reports said *six
  other agents* and gave two. `reports` is the lead position's children joined
  through the same predicate `AgentTeams::reports` uses, so the picker reads
  the number the spawn will resolve against and the composed persona cannot
  disagree with it. `positions` keeps meaning *every seat*, which is what the
  map and the list row want.

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

Counted across **every owner** — somebody else's schedule is no less stopped
for being somebody else's, and a person about to stop four has to be told four
even where they may never read one of them. **Given only to somebody who could
save**: it is zero for a reader, and the notice is not drawn for one. A
consequence-of-saving count beside a Save a `Viewer` cannot press tells them
nothing they can act on and tells them how much unattended work other people
have pinned to a shared team.

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
  one level down. **The database holds this one too** —
  `agent_team_one_profile_per_parent`, a partial unique index on
  `(parent_id, profile_id)` — because a check in the server is a check with a
  gap after it, and the compatibility window's insert raced that gap: two
  spawns naming one profile at the same moment both saw no seat and both added
  one. What that produced was worse than a duplicate row, since the team could
  then be neither saved nor spawned into by name. The constraint belongs to
  this rule and landed with #491 because branches were stacked on this one.

  One cost, and it is the index's. The constraint is checked per statement and
  a save writes kept seats one at a time, so **a kept seat cannot take a
  profile that any other row under the same parent still holds** — including a
  row the same save is removing, because the `DELETE` is last on purpose (a
  departing seat with a kept child under it would cascade the child away
  before the write re-parents it). Two shapes reach it: two seats *trading*
  profiles, and — likelier on the map — one seat removed while another is
  pointed at the profile it was holding, where nothing is trading at all.

  Both are refused with a sentence that states that condition and names the
  step: save the change that gives the profile up first, then the change that
  takes it. A longer chain of reassignments needs that step more than once,
  and the sentence says so.

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

`roles.delegate_scope` is not **copied**: a profile that never spawned gets an
empty team even when somebody had narrowed its scope, because a scope that was
never exercised is a guess about intent the same way a visibility snapshot is.
An empty scope still means *any*, which was the old default.

**A narrowed scope is read, as a ceiling on what history may resurrect.** That
is the other direction and it goes the other way: a scope is the one way reach
was ever taken away. A Manager that spawned an Auditor last March, narrowed
since to exclude it, is refused the Auditor by the old path today — so seeding
the March spawn back in as a position would undo a revocation nobody asked it
to undo. History is intersected with the scope, which puts seeding and the
window on one rule: what the intersection drops at the cut can still arrive
later through real use, marked.

**And a seat its team's author cannot see is not written.** Lineage is read
across every owner, which is right — a shared profile's history belongs to
everybody who used it — but a colleague's spawn of a profile of *their* own
would put that private profile into a team filed in somebody else's directory:
a seat its owner is shown without a name on it, in a team they can then never
save, because `must_see` refuses their write on an id they cannot resolve, and
a save is the only way to clear a mark. So each candidate seat passes through
`agent_teams::admissible`, which is `must_see`'s question asked of the team's
author. **Every team keeps at least one person who can always save it.**

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
4. **It opens only for somebody who could have drawn the seat by hand.** The
   window is a *write* — a permanent row in the structure that decides what
   agents may do — so it asks the `Writer` the editor asks, through the one
   predicate, and does not open for a reader. A `Viewer` on a shared seeded
   team gets the ordinary refusal, which is what the Agent teams screen would
   have told them. What it may seat is bounded the same way seeding's is, by
   `admissible`: a profile the team's author cannot see is refused by name
   rather than written.
5. **A seat it adds stops the schedules pinned to the team**, exactly as an
   edit does — `paused_reason = 'team_changed'`, re-pinned on the tree as it
   now stands. It is a fourth path that changes a tree, and the launch gate
   failing closed at nine in the morning is not the same as telling somebody
   before it.
6. **It closes.** `agent_teams::window::WINDOW_DAYS`, measured from
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
rule. **A refusal that points at a position names it**: the rules are a pure
function over ids, and `check` is handed the names the transaction about to
write has already read, so a profile under itself and two of one profile under
one seat read as *Engineer* rather than `role_01…`. It is resolved on the
server rather than in the editor because this API, the YAML import and three
generated clients all meet the same sentences. The one refusal that still
prints ids is the one about profiles filed where the caller cannot reach them,
where there is no name to read and reading one would disclose what the filing
withholds.

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

## The screen

`/configuration/agent-teams`, under Customize, directly after Agent profiles.
Two surfaces: every team, and one team's map.

**The list** says who leads a team, who else is in it, how many positions it
holds and how deep it goes — all four off `GET /api/v1/agent-teams`, in one
request, so the map is never the only way to see a team. Its search matches a
team, its lead, or **anybody in it**, which is how somebody finds the teams one
profile sits in.

**The map** draws the tree as **Hybrid**: the lead and its children spread
horizontally with elbow connectors, and from the second level down, where the
shape is a chain, it indents. This was measured. A full organigramme throughout
came out at 4640px wide on the hardest lane — 3.9 screens — because an org
chart gives each card one parent, so one profile under three managers becomes
three cards; the width is the duplication, not the card. Hybrid came out at
504px and complete. `desktop/src/ui/config/team-map.test.ts` asserts the two
measured lanes still come out at 648 × 296 and 862 × 226, so the arrangement
fails a test rather than drifting.

**The map writes a draft and Save is the only commit.** Adding, removing and
re-parenting change a tree held in the client; the action row says how many
changes are waiting, and Discard is an assignment back to what the server
answered — which is how a removed subtree comes back whole, the tree it was in
never having been touched. Save sends the whole tree through
`PUT /api/v1/agent-teams/{id}`, carrying each kept seat's id.

Three things a card has to say that it would be easy to leave unsaid:

- **What a removal takes.** A position owns its subtree, so the control states
  the descendant count before it is pressed — *Take Engineer and the 3 under it
  out of this team*. There is no confirmation, because a removal is a draft.
- **A seat whose profile the reader cannot see** keeps its place and loses its
  name: a dashed card with the profile's id, a thing that is there and
  unreadable rather than an error. A gap would misrepresent the team.
- **A seat a hand-off added rather than a person** is marked, and the map
  offers a way to step through them. That visibility is the whole mitigation
  for a team that can grow without anybody choosing.

Save and Discard live in the map's own action row and not in a status strip:
the desk has one control height, 30px, and 22px of window chrome cannot hold
one.

## Built by an agent

Somebody says *"create a Firetower Team with the following profiles: Manager
(will lead the team), Engineer, Designer, QA, Security advisor"* to a session,
and the agent builds it. Six tools on the internal MCP —
`crates/ft-worker/src/approver.rs` declares them, `crates/ft-server/src/delegate.rs`
answers them — beside the profile tools, because reach is what a profile no
longer carries:

| | |
| --- | --- |
| `create_agent_team` | a name, the profile that leads it, the lead seat's own instructions, a directory |
| `add_position` | a team, the profile the seat references, the position it reports to, instructions for that seat |
| `remove_position` | a team, the seat, and `with_reports` for the subtree |
| `rename_agent_team` | a team and its new name; the tree is untouched |
| `list_agent_teams` | every team, its lead, its size, its depth, its reach, who else is in it |
| `get_agent_team` | one team's whole tree |

Asking the person what to put in it needs nothing new — a session already
talks to somebody — and `list_profiles` already answers *is there a Designer
already*. The gap was that there was no way to make or read a team at all, so
an agent could create a profile and could not put it anywhere.

**They are named `agent_team`, not `team`.** `create_team` is unclaimed on
this MCP, and that is exactly the problem: *team* already means a group of
people here, the people's table is `teams`, and the day a people-team tool
arrives the shorter name is the one it wants. An agent reading `create_team`
beside `create_profile` has no way to tell which noun it got. The route is
`/configuration/agent-teams` and the table is `agent_teams` for the same
reason, so the long name is the consistent one as well as the clear one.

**Names, not ids, throughout** — the convention `delegate.rs` already keeps.
A name two teams answer to is refused by `at_most_one`, naming both, and
`create_agent_team` refuses to *make* the second one: these tools find a team
by name, so a duplicate makes both unreachable and the agent that made it is
the one that can no longer act. A seat is named by the profile in it, or —
where a profile sits in one team twice, which is what per-position
instructions are for — by its chain from the lead down, `Orchestrator >
Engineer`. The ambiguity refusal hands back exactly those chains, because a
refusal naming candidates the next call cannot say is a refusal an agent
cannot act on.

**No tool here writes a position.** Every write goes through
`AgentTeams::create` or `AgentTeams::write`, which are the editor's own two
writes: they take `filed_where(t, Writer)` inside the transaction that writes,
and they call `agent_teams::check`, so depth and the position count are one
rule in one place. That is the direct answer to #508 — a fourth writer into
`agent_team_positions` with every gate on its path answered at `Viewer` — and
to #516, which would assert that every writer of that table names a predicate:
these tools add no writer, so there is no second predicate to keep in step
with the first. A name is still resolved at the level its write needs, so that
a reader of a shared team meets a sentence about access rather than a bare
not-found, which an agent answers by creating a second team of the same name.

**And every answer says what the write cost.** A tree that changed stops the
schedules pinned to it, by the same `unapprove_schedules_on` the editor, the
delete and the window call, and the count is read before the write and said in
the answer — with the fact that no tool here can turn one back on. A removal
names the seat and everything that went with it; `get_agent_team` says how
many schedules a change *would* stop, before it is made.

Two deliberate gaps, each its own ticket's worth of work rather than a bug:
there is no tool that changes a team's lead, because that re-mints every
position in the team and takes the sessions standing in them off their seats,
and no tool that deletes a team — this MCP has no delete for a profile, a
skill or a schedule either. Both are the person's, on the screen. An agent may
also not set a seat's instructions after the fact; it removes the seat and
adds it again.

### The old per-profile reach, from here

`create_profile` and `update_profile` still take `can_delegate` and
`delegate_scope`, and still honour them, because the old path still works for
the window's duration and refusing them today would break what works. What
changed is what the agent reads: both fields now say they are the older
per-profile reach, say they are on their way out, and name
`create_agent_team` and `add_position` as the replacement — so an agent
reaching for the field it knows learns the tools exist. Refusing them belongs
with #497, when the column goes.

## The drawer

**One editor, for a profile and for a position**, in the window's own right
rail — the same rail `Workbench` opens beside a conversation, whose numbers
are in `desktop/src/ui/right-rail.ts`. It opens from a row in **Agent
profiles** and from a card on a map, and there is no second editor: the
full-page profile form is gone, because two editors over one object is what
this design removed.

Five tabs, and they are questions rather than categories: **Custom · What it
is · Skills · How it runs · In teams**. *Custom* comes first from a card,
because what that seat says is what somebody pressed the card to change; from
a library row there is no seat and the tab is not drawn.

**A position adds and never replaces**, so *Custom* draws the profile's own
instructions above the box somebody types in, in one frame with the join
labelled. That is the rule as a control rather than as a caption, and it is
why the tab is *Custom* and not *Overrides*.

**One band under the tabs** says whether a change reaches this team or every
team using the profile. It is there because the other team is not on screen,
which is the one consequence nothing else can show.

**Re-parenting is here and not on the map.** *Reports to* is a field of a
position, the map draws no control for it, and the draft it edits is the
map's — so a move joins the pending count and Discard puts it back. A seat's
own instructions are part of that draft too.

**Where the rail sits is measured on the pane, never on the window**, because
the pane has the rail and the index beside it. Dock at 820 and over, float
between 600 and 820, push below. The desk's pane measures 974, so it docks at
370 and the screen keeps 604; a 669pt Duo inner display lays out at 607 and
floats, which is the number the rule exists for.

**A seat whose profile the reader cannot see** opens as the id and the seat's
own instructions, and nothing else. The id is disclosed by design — a gap
would misrepresent the team — and the drawer is *told* the name was withheld
rather than working it out, because working it out means reading the profile
list.

**Deleting a profile cascades**, and the confirmation names every team and the
positions each one loses first. `GET /api/v1/roles/{id}/positions` answers
that and the *In teams* tab in one request.

The cascade does **not** filter — `profile_id` and `parent_id` are both `on
delete cascade`, so it reaches every team in the organisation — and the read
behind the confirmation does, as every read does. So the response is a list
*and a count*: the seats in teams this person can see, named, and a bare
number for the ones in teams they cannot. The shape may be disclosed, the
names may not, which is the rule a withheld member name already follows. The
confirmation says *and 2 positions in teams you cannot see* rather than
asserting a fact about rows it did not read.

And the delete **stops the schedules** pinned to every team that loses a seat,
including the ones it could not name — the same `unapprove_schedules_on` the
editor and the team delete call. Otherwise the person on the other side of
that boundary, who was never party to the delete, finds out from a failed run.

## Not yet

Each of these is its own ticket, and this one is what they are blocked on.

- **Read-only on mobile** (#495) and **YAML import and export** (#496).
  Starting work as a team is already on the phone; #495 is the teams *screen*.
- **Dropping the old per-profile reach** (#497), which is the contract half.
  Three things in the picker go with it, and all three read `canDelegate`: the
  *can delegate* chip, the third sentence — a Manager profile that still hands
  work out through its own settings — and the delegating-first sort among the
  profiles. One field, one removal.
