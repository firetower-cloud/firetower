# Permissions

Who may see a thing, who may use it, and who may decide what becomes of it.

This is the whole model in one place. `paths-and-ownership.md` covers the
schema that carries it and `teams-and-directories.md` covers the screens; this
is what they are both expressing.

---

## 1. Two roots

Everything a person can own is filed at a **path**, an `ltree` with one of two
roots:

```
u/kevin/ledger_rounding     somebody's own space
d/backend/fire-01           a directory's
```

`u/<slug>` is a person. `d/<slug>` is a directory. There is no third root, and
the root is the first thing every rule looks at.

A person's `u/<slug>` is **implicit** — no row creates it, nothing can delete
it, and it needs no grant. That is the simplification paths bought: a new
person needs a principal with a slug and nothing else.

Five kinds are filed: **workspaces**, **machines**, **agent accounts**,
**secrets** and **repositories**. Four of them can move. Repositories cannot —
see §7.

Some secrets are **attached** rather than filed: an agent account's credential
(`agent/…`), a repository's variables (`env:…`), and the installation's own.
They have no path, they belong to the thing they are attached to, and they move
when it moves. `path IS NULL` is what attached looks like in the schema.

---

## 2. Three levels

| Level | Means |
| --- | --- |
| `viewer` | may see it |
| `writer` | may work in it, and put their own things into it |
| `admin` | may decide what becomes of it |

Ranked, and compared by rank rather than by name. The gap that matters is
between `writer` and `admin`: **a writer may put their own things into a
directory and may not take anybody else's out.** That is what stops a member
pulling the fleet's shared machine out from under everybody.

---

## 3. One definition of "may see this"

`access::filed_where` is the only place it is written down. It generates one
SQL predicate, used by every list in the product, and it is true if **any** of
these is:

1. The path is under the asker's own root — `u/<their slug>/…`.
2. The path is under a directory they reach at the required level or better.
3. They are **named on the resource** at that level (`extra_perms`).
4. A **team** they are in is named on the resource at that level.

Directory access itself is the `directory_access` view, which resolves three
routes and takes the **maximum**:

- granted to them personally,
- granted to a team they belong to,
- granted to the team that is **everybody**.

So two grants never need a tie-break: the most access anybody was deliberately
given is what they have.

### The team that is everybody

One per organisation, flagged `everyone`. It has **no membership rows** — the
view joins every user in the organisation directly. Whoever is in the
organisation now is who it is, and there is nothing to go stale. It is a
subject you grant to, not a group you maintain.

### Exceptions

`extra_perms` is a JSONB object on the resource:

```json
{"u/lisa": "writer", "t/backend": "viewer"}
```

It exists because a directory is how a company shares a *body of work*, and
this is how one person lets one colleague into *one thing*. Without it the only
way to show Lisa a workspace would be to create a directory containing both of
you and hand the workspace to it — a lot of machinery for "let Lisa see this",
and it transfers ownership as a side effect.

An exception can never be `admin`. Somebody let into one thing cannot
administer it; share the directory it is in instead.

**An exception is not derivable from anything the client holds.** It lives on
the resource and in no directory, so a client that knows its directories and
their levels still knows nothing about it. Anything the interface needs to draw
from it must be sent by the server — see §6.

---

## 4. One definition of "may decide about this"

`api::access::may_share`. Seeing a thing and disposing of it are different
questions, and this is the second one. It answers yes for:

- the person whose **own root** it is in, or
- an **administrator of the directory** it is filed in, or
- an **organisation administrator** — but never for a personal root.

It is asked about moving something into a directory, and about ending a
workspace, because deciding where a thing is filed and deciding that it stops
existing are the same right.

### The personal rule

**Anything under `u/<somebody>/…` is non-transferable by anyone except its
owner.** An organisation administrator is not an exception.

Everywhere else `role == "admin"` is the way back in when a directory's last
administrator has left. Here it would be the way into somebody's private work.
An administrator can **destroy** what is at `u/<them>/…` when removing that
account — the account is going, that is unavoidable — but they can never
*take* it, because handing it to a third party is the one outcome the owner
never agreed to.

---

## 5. The organisation role

`users.role` is `admin` or `member`. It is not a level and does not appear in
any path. It gates exactly four things:

- people — adding, removing, changing a role, resetting a password
- teams and directories
- the OAuth application the whole installation authorizes against
- upgrading the control plane

A member administers nothing organisation-wide and may still administer a
directory they were granted `admin` on. The two are independent.

---

## 6. A place is not a conversation

A workspace is a directory on a machine. A session is one agent working in it,
authenticated with **one person's** subscription, pushing with **their** git
token under **their** name.

So the level on the workspace answers one question and not the other:

| | Who |
| --- | --- |
| **may read** | viewer on the workspace |
| **may work here** | writer on the workspace |
| **may speak in this conversation** | writer **and** the session's owner |

`may_speak` has **no administrator bypass**, for the reason personal paths have
none: being able to administer an organisation is not being able to spend
somebody's subscription.

Sorted accordingly:

- **The conversation's** — turns, answers to the agent's permission prompts,
  interrupts, model and effort, attachments, preview notes. And committing,
  pushing and opening a pull request, because all three go out under the
  owner's git identity.
- **The place's** — starting another agent, attaching a repository, renaming,
  the compute share, the terminal. A shell in a shared worktree is the room's;
  gating it would pretend the worktree is private when it is not.
- **Ending** splits: one agent is its owner's; the whole workspace is
  `may_share`.

A path says *who is responsible for a resource* — transferable, grantable,
movable into a directory. A session's `user_id` says *whose credentials are
inside a running process*, and that is not transferable at all.

**You can hand over a place. You cannot hand over a conversation.** Which is
why joining somebody's work means starting your own agent beside theirs rather
than taking theirs over.

---

## 7. Repositories are personal, always

A repository belongs to whoever connected it. `u/<slug>`, never a directory,
and `may_share` refuses to file one anywhere — by name, before it reaches the
question about roots.

What opens a repository is the token of whoever connected it, so the row is
theirs in the strong sense. Two consequences:

- **One remote per person.** `unique (org_id, remote, path)`. Two people on one
  codebase is two rows, each with its own setup script and variables. The old
  `(org_id, remote)` is what forced the opposite: the second person to connect
  `acme/backend` could only be handed the first person's row, so the row had to
  belong to everybody.
- **`added_by` cascades.** Everything personal is destroyed rather than handed
  on when its owner leaves, and the database enforces it so no code path can
  forget.

---

## 8. What sharing a workspace does not protect

Stated here because no permission level fixes either, and discovering them
later is worse than reading them now.

- **Files.** A viewer can list and download what is in the workspace,
  including a repository's variables written there as `.env`. Sharing a
  workspace shares its secrets.
- **The worktree.** Agents in one workspace share one directory and can
  overwrite each other's edits. The worker reclaims it when the last agent
  leaves, which is the only part of this that is coordinated.

---

## 9. Rules for adding to this

- **One predicate, not a second opinion.** Anything that asks "may this person
  see this" asks `filed_where`. Anything that asks "may this person decide
  about this" asks `may_share`. A handler that works it out for itself will be
  wrong the first time two people change something at once.
- **Refuse as `NotFound`, not `Forbidden`.** What somebody may not touch, they
  are not told is there. `Forbidden` confirms a thing exists, which is the one
  fact the asker had no way to learn. The exception is where the rule itself is
  the useful message — filing a repository, ending somebody's workspace.
- **Never draw a control the server will refuse.** It reads as the product
  being broken rather than as a permission somebody does not have. Where the
  client cannot work the answer out — and for exceptions it cannot — the server
  sends it: `maySetApplication`, `mayWrite`, `maySpeak`, `mayUpgrade`.
- **Default to the old behaviour when a field is absent.** A client talking to
  a control plane that predates a permission field must behave as it did
  before. `!== false`, not truthiness: reading an absent field as "you may only
  watch" takes every control away from the person whose work it is.
