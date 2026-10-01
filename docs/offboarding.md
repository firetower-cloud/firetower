# Offboarding somebody

**Status: scoped, not built.** This is the design to build against.

Removing a person is the one destructive action in Firetower that cannot be
undone and cannot be partially done. Today it is a single `DELETE` behind a
warning written in the abstract — *their workspaces go too, and their
credentials* — true of anybody, silent about this person. What follows replaces
that with: see what is theirs, decide about each of it, and have all of it
happen or none of it.

## The rule it rests on

> **What is filed at `u/<them>/…` is theirs, and nobody else can ever be given
> it — including an administrator.**

Removing the account destroys what is there, and that is unavoidable: the
account is going either way. What is *not* allowed is passing it on. Handing
somebody's private work to a third party is the one outcome its owner never
agreed to, and "they left" does not make it agreed. The only way out of a
personal root is the owner moving it themselves, before they go.

Enforced in `may_share`, which is the one definition of who may move a thing —
the administrator bypass there now applies to directories and not to somebody
else's root — and mirrored in `mayMove` on both clients so the control is never
drawn.

It does not depend on the kind. A workspace, a machine, a subscription and a
secret are all equally theirs, and the earlier draft that let an administrator
hand over "a thing" but not "an identity" needed a judgement per scope that
nobody should have to make twice.

The cost, stated plainly: **work left in a personal root dies with the person.**
`u/kevin/ledger_rounding` is destroyed when kevin goes, and the only way to keep
it is kevin filing it into a directory first. That is the price of the rule and
it is worth it, but it means "file your work somewhere shared" has to be
something people are told rather than something they discover.

## What is decided

One thing, and it is not about property.

### Directories where they were the last administrator

A directory is the organisation's, so this is a job to hand on rather than a
possession to take. The screen offers a successor for each; leaving it empty is
allowed, because `may_administer` returns early for an organisation
administrator and so a directory is never unreachable.

### Everything at their own root

Listed, counted, and not decided — because there is only one thing it can do.
Each row says what going actually means for *that* kind: a workspace, a
subscription or a secret is deleted, and so is a machine. Machines used to be
swept into `Shared` on the grounds that compute is real; that is an unconsented
transfer and it is gone. The server itself is untouched — the row is what
disappears, and whoever wants it back adds it again.

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
