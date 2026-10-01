# Offboarding somebody

**Status: scoped, not built.** This is the design to build against.

Removing a person is the one destructive action in Firetower that cannot be
undone and cannot be partially done. Today it is a single `DELETE` behind a
warning written in the abstract — *their workspaces go too, and their
credentials* — true of anybody, silent about this person. What follows replaces
that with: see what is theirs, decide about each of it, and have all of it
happen or none of it.

## What has to be decided

Three buckets, and only the first two need an answer.

### 1. Theirs — filed at `u/<their slug>/…`

Workspaces, machines, agent accounts, secrets. **This is what a deletion
destroys**, and so this is the list that needs a decision per row:

* **Hand over** — to a person, or to a directory. `Access::transfer` already
  does exactly this, including re-sealing a secret or an agent account's
  credential under its new owner.
* **Delete** — say so explicitly, per row.

A bulk default sits above the list — *hand everything to…* — because deciding
forty times is not deciding, it is clicking.

### 2. Directories they administer

`delete_user` removes a person's grants with a plain `DELETE` and no
`keep_an_administrator` check, so removing the last administrator of a directory
is possible where revoking their grant one at a time is not.

**It is a warning and not a blocker**, because an organisation administrator can
administer any directory whether or not anybody granted them anything —
`may_administer` returns early on `role == "admin"`, and that fallback exists
precisely so a directory whose last administrator left is fixable. Refusing to
offboard somebody over a recoverable state would be the wrong trade.

What is lost is real but smaller than it first looks: the people who *worked*
there can no longer file anything out of it or change who it lets in, and only
an organisation administrator can. So the screen says who would be left — and
offers to name a replacement, with the field already filled in — without
standing in the way.

The same reasoning applies to `d/shared`, which every installation starts with
and which has no administrator at all: its only grant is writer to the team that
is everybody. That is not a defect to repair; it is the fallback working.

### 3. Theirs by creation, filed somewhere else

Anything with `created_by = them` whose path is under `d/…`. **Nothing to
decide**: filing handed it to the directory, it does not go with them, and
`created_by` is a record of who made it rather than a claim on it.

Shown anyway, as *stays where it is*. Somebody deciding about a person wants the
whole picture, and the absence of an action is itself the answer to "what
happens to the thing ana built for the backend team".

## What happens with no decision

Their grants, their team memberships and every exception naming them are
revoked. Those need no choice — they are access, not property, and access to
somebody who no longer exists is a row that resolves to nothing. `principals`
keeps their slug and name forever so that nothing can ever reuse it.

## The shape

```
GET  /api/v1/users/{id}/reach        — already built; needs two fields added
POST /api/v1/users/{id}/offboard     — new
```

`reach` grows:

| field | why |
|---|---|
| `administers: [{ directory, alone: bool }]` | bucket 2, and `alone` is what blocks |
| `created: [Filed]` | bucket 3, shown and not decided |

`offboard` takes the decisions and does the work:

```jsonc
{
  "hand_over": [ { "kind": "workspace", "id": "…", "to": "u/bob" } ],
  "delete":    [ { "kind": "secret",    "id": "git/github/u_…" } ],
  "administrators": [ { "directory": "d_…", "person": "u_…" } ],
  "then": "disable" | "remove"
}
```

Every item in `reach().owns` must appear in exactly one of `hand_over` or
`delete`. The server checks that and refuses the lot otherwise — a
half-specified offboarding is the thing this exists to prevent. `administrators`
is optional, because a directory left without one is recoverable by an
organisation administrator.

## One transaction, which is the real work

`Access::transfer` and `Vault::hand_over` each open their own
(`self.pool.begin()`), so twelve transfers are twelve transactions and a failure
on the seventh leaves five done. Both have to take an existing
`&mut Transaction` instead, along with `delete_user`, and offboarding opens one
and threads it through everything.

That refactor is most of the cost of this feature. It is also worth having on
its own: the same gap means a transfer that fails half way through an
agent account — row moved, credential not re-sealed — is possible today.

Re-sealing is CPU work inside the transaction. For the sizes involved
(tens of rows, not thousands) that is fine, and correctness is worth more here
than lock duration.

## Order

**Disable before remove.** Somebody who can still sign in can make more while
you are deciding about what they have. `disabled` already exists and already
stops a sign-in; offboarding requires it first.

## Where it lives

The administration site, by `docs/which-surface.md`: who exists is the
organisation's. It is the user-centric view of permissions — *ana → what she
reaches, what is hers* — which is the mirror of the desktop's resource-centric
*this workspace → who reaches it*. Both touch access; neither duplicates the
other.

## What this does not do

**No undo.** A handover is a real transfer and a deletion is real. The
protection is that nothing happens until every row has an answer, and then it
all happens at once.

**No scheduling.** No "remove in 30 days". Disable does that job already, and a
queue of pending deletions is a second source of truth about who exists.
