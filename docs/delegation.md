# A session can start other sessions

**Status:** built, first slice. `20261028120000_lineage.sql`,
`crates/ft-server/src/delegate.rs`, the `spawn` and `children` tools in
`crates/ft-worker/src/approver.rs`.

A session can ask Firetower for another agent and hear back from it. The
session that asks is a *lead*; what it starts is a *child*. A child is an
ordinary session — its own conversation, its own row, its own transcript —
with one extra fact: which session asked for it. Everything in this document
hangs off that one fact.

## What it does

From inside any session, the agent has two more tools on the `firetower` MCP
server it already uses for permissions:

| Tool | Does |
| --- | --- |
| `spawn` | Starts a child. `placement: "here"` is another agent in this workspace, sharing its directory and branch — a reviewer, a second pair of eyes. `placement: "new"` is a workspace of its own, on its own branch, cut from the lead's first repository. Returns the child's id and name at once. |
| `children` | `list` what each child is doing and whether it is waiting on someone; `steer` sends a message into one child's conversation mid-run; `stop` ends the turn a child is in. |

When a child hands back, its last turn is delivered **into the lead's
conversation as a message**, between the lead's turns. Several children handing
back while the lead is mid-turn arrive together as one message. The lead's
*own* turn ending while children are still working leaves the lead `Working`,
not `HandedBack`: nothing is for the person yet.

The person's inbox stays what it was. A child's hand-back never notifies
anybody — that is the lead's to hear. A child that needs a **permission**
still reaches the person, because a lead may not approve on anybody's behalf.
A child cannot `spawn`, cannot ask the person, and is told so.

Ending a lead ends its children. A branch a child pushed stays on the remote.

## How it travels

No new frame. A call to `spawn` goes down the road a permission question
already takes — the session's unix socket, then the worker's `AgentAsks` —
with its name prefixed `firetower:`. The fleet's connection loop recognises
the prefix and hands the call to `delegate::serve`, which has `AppState` and
starts the child through the same `create_session_as` the API uses, as the
lead's owner. The answer goes back down the same road, as the text of the
tool result. An older control plane shows the call as a permission card
instead; nothing disconnects.

Starting a child is exactly starting a session. The owner is the lead's
owner, read off the lead's row — no token is minted for a session to act with.
Every check a person starting a session meets, a lead meets.

## Where things are written down

- `sessions.parent_id` — the edge. Null for every session a person started,
  which is every session there was. `on delete set null`, because a child's
  branch may be work somebody wants.
- `sessions.spawn_reason` — what the lead said the child was for, shown on
  the child.
- `sessions.spawn_req` — the lead's id for the call that asked. A worker that
  reconnects re-announces every question its agent is blocked on, so a spawn
  can arrive twice; this is what answers the second arrival with the child the
  first one made.
- `deliveries` — a child's result, held while the lead's agent is mid-turn,
  sent the moment it is not. Kept after sending.

## Limits

Flat: a child cannot spawn. At most 4 children in flight per lead and 8 over
its life. A refusal is a sentence the agent reads — which limit, and what is
holding it.

Money and wall-clock caps are not here. Firetower shows a quota at 100% and
does not interrupt a running agent; a cap that interrupts is a new behaviour
and a new kind of failure.

## In the desktop

A child in a workspace of its own is drawn under its lead in the rail,
indented. A child started *in* the lead's workspace is another mark on the
lead's row, which is what it is. A lead's row shows `↳N` while N of its
children are at work. A child's conversation opens with who started it and
why, and links back.

`needsYou` — and so the inbox, the island and the dock badge — does not count
a child that handed back to its lead.

## Trying it

```sh
just db && just dev           # control plane, localhost worker and web
cd desktop && pnpm app        # the Mac app, connected to http://localhost:4400
```

The localhost worker is this build's own binary, so the new tools are there
without installing anything. Start a workspace on a repository with Claude
Code, and ask it something like:

> Add input validation to the API handlers. Then start a child in this
> workspace to review the diff and tell me what it finds.

The first `spawn` is a permission card — *start a child agent: …* — because
the agent has not been allowed that tool before; *Always* writes the rule.
Watch the rail: the child appears under the lead (or as a second mark on its
row), the lead's row says `↳1`, and when the child hands back its result lands
in the lead's conversation rather than in the inbox.

## Not yet

Each of these is a smaller change on top of what is here.

- **Roles.** A saved narrowing — agent, tools, placement, what it hands back,
  an `AGENTS.md` of instructions — that a lead can pick by name and a person
  can `@mention`. Today a spawn is described inline.
- **A child's questions routed to the lead.** A child's `AskUserQuestion` goes
  to the person, as any session's does.
- **Take over.** Detaching a child from its lead so its hand-backs come to
  you instead.
- **Who said what.** A user turn in a child's transcript does not yet carry
  whether the lead or a person typed it; the lead's turns are prefixed in
  words instead.
- **A child whose lead has ended** keeps its hand-back for a lead that will
  never read it. The rail still lists it; the inbox does not.
