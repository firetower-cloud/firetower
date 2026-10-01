# Paths and ownership

**Read this before you add a table, an endpoint or a screen.** It is the part of
Firetower that a new feature gets wrong silently: not by crashing, but by
returning somebody else's rows to somebody who then never finds out they saw
them.

It is written for whoever is doing the next piece of work here, human or model.
It says what the rules are, what you have to do to obey them, and — at the end —
the four mistakes that have actually been made.

---

## 1. The one sentence

**Every thing a person can own has a `path`, and the path says who can reach
it.**

```
u.<person>.<name…>      their own space. No grant, no row, nobody else.
d.<directory>.<name…>   whoever holds a grant on that directory.
```

Two roots and only two. There is no third.

The column is Postgres `ltree`, so the separator is a dot; the wire and every
screen use slashes (`u/kevin/ledger_rounding`). `ft_core::ResourcePath` is the
conversion and the only place either spelling is written by hand.

### The first two labels are the whole of the permission

`subpath(path, 0, 2)` is the *permission root*. Everything after it is a name
with separators in it, for people to read. `d/backend/eu/west/fire_01` is filed
in `backend`, full stop — the `eu.west` buys nothing and costs nothing.

This is deliberate and it is what makes the access check one indexed predicate
(`<@` against a GiST index) instead of a recursive query. It is also why there
are no deny rules to reason about: nothing below the root can take anything
away, because nothing below the root grants anything.

### Filing something hands it over

Moving a thing to `d/backend` gives it to that directory. Whoever moved it keeps
access only as somebody `backend` grants — possibly none. This is the Windmill
rule, chosen on purpose: one source of authority over a thing, and no second
concept sitting beside the path disagreeing with it.

`created_by` is kept on every resource so the record of **who made it** survives
it changing hands. It is a fact, not a permission. Nothing reads it to decide
anything.

---

## 2. The three kinds of thing

Before you give your new table a `path`, work out which of these it is. Getting
this wrong is the most common mistake in this area.

### Placed — it has a path

A workspace, a machine, an agent account, a secret somebody authorized. It can
be filed, moved, and listed in a directory. It gets:

- `path ltree not null` (nullable only if some rows of the same table are
  *attached* — see `secrets`),
- a GiST index on `path`,
- a unique index on `path`,
- `created_by text references users(id) on delete set null`.

### Attached — it has no path, and moves with its parent

An agent account's own credential (`agent/<credential_key>`), a repository's
variables (`env:<repo id>/…`), the installation's own secrets. These belong to
something else. A path of their own would be a second answer that could
disagree with the first — a subscription filed in one directory whose token
still opens under the person who connected it.

`path IS NULL` is what attached looks like in the schema. Anything attached must
be listed in `Access::transfer`, which is the one place a thing changes hands
and therefore the one place that knows what hangs off what. SQL cascades a
delete and cannot cascade a move.

### Exceptions — `extra_perms` on a Placed row

A few named people on one thing, on top of where it lives. `{"u/lisa":
"writer", "t/backend": "viewer"}` — slugs, and `viewer` or `writer` only.

It is a **fourth route in, not a second source of authority**:
`directory_access` already reduces three routes with `max`, and this is one more
input to the same `max`, so two answers can never contradict.

Four rules, each closing something:

- **never `admin`.** Administration belongs to the path, so one place answers
  "who may change permissions". Somebody admin-by-exception could otherwise
  rewrite the grants of a directory they were only an exception to
- **additive only.** There is no way to spell a denial, and there never will be
- **never ownership.** The path and `created_by` stay the record
- **only on Placed rows.** An exception on an attached secret would be a way to
  reach a subscription's token without reaching the subscription

Both clauses in `filed_where` lead with a key test (`?`, `?|`) because that is
what the GIN index can answer; the level is rechecked on the few rows that
matched. The team clause is uncorrelated on purpose — its subquery never
mentions the outer row — so the array of team keys is built once. Write it as a
correlated `EXISTS` and you have a sequential scan on every list in the product.

### Recorded — an append-only fact about the past

Events, agent output lines, usage, the vault's access log, step attempts. These
do not have owners and do not move. Stamp them with who did it and when; never
update them, and never file them. A record of the past does not change hands.

> Worked example. "Token consumption" would be **Recorded**: rows stamped with
> the session and the account they were spent on, read through the path of the
> *session* — which the reader already has to be allowed to see. It needs no
> path, no grant, and no new concept.

---

## 3. Obeying the rules

### Reading

`access::filed_where(alias, person, at_least)` is **the only definition of "may
see this."** Every read that enforces access pastes it into its `WHERE`:

```rust
let sql = format!(
    "SELECT {COLUMNS} FROM widgets w WHERE {visible} ORDER BY w.created_at",
    visible = filed_where("w", 1, Level::Viewer)   // $1 is the person's id
);
```

One function with one set of callers is something a reviewer can check by
grepping. The failure worth defending against is not a wrong design; it is a
query added next spring that leaves the condition off and quietly returns
everybody's rows.

Two things follow from this:

- **Never hand-write the predicate.** If you find yourself typing `path <@`,
  stop.
- **Never expose an unfiltered read from a handler.** `Db::hosts` and
  `Db::session` exist for the fleet — a supervisor reconnecting is not acting
  for anybody. `Db::hosts_for` and `Db::session_of` are what a request asks.
  Both pairs say so in their doc comments; keep that up.

### Levels

| | |
| --- | --- |
| **Viewer** | Find it, open it, read what happened. |
| **Editor** | Also start an agent, answer one, use the terminal, ship. |
| **Admin** | Also decide who else can, and what is filed there. |

The middle one is `writer` on the wire, in the database and in `Level` — and
**Editor** on every screen. The product word and the schema word differ on
purpose: `writer` is about a row, and renaming a column to follow a label is how
a migration gets written for no reason.

A read takes `Viewer`. **Anything that changes something takes `Writer`.** The
two are separate methods rather than a level argument, so that a handler naming
the wrong one reads wrongly at the call site:

```rust
state.db.session_of(owner, &id)          // watching it
state.db.session_to_work_in(owner, &id)  // ending, renaming, a turn, a terminal
```

Absent, not refused, when they may not: a 403 and a 404 differ only in
confirming the thing exists, which is itself something the asker was not meant
to learn.

`Admin` is what it takes to move something **out** of a directory. A writer can
put things in and cannot take somebody else's out. That is what stops a member
pulling the fleet's shared machine out from under everybody.

### Writing

A new row is born in its creator's own space:

```rust
let path = format!("u.{}.{}", db.slug_of(owner).await?, ft_core::slug(name));
```

Never build one from a display name without `ft_core::slug`: `ltree` labels are
`[A-Za-z0-9_-]`, so `Ledger work` is a *syntax error*, not a slow query. And
never make anybody type a path — the UI shows a location chip, and the path is
something the server computes.

Names collide, so append a discriminator where two things of a kind can share
one (`ledger_rounding_01m3qbzd`). The unique index will otherwise refuse the
insert, and two agents on the same branch is the ordinary case, not a corner
one.

### Moving

`Access::transfer(vault, kind, id, to, by)` — **the one place a transfer
happens.** It takes the attachments with it and re-seals what needs re-sealing.
If you add a kind, add it there.

### Slugs

`principals.slug` and `directories.slug` are derived once and never change. Renaming
a person or a directory changes what people read; it must never rewrite a path,
because rewriting one moves everything under it.

Principal slugs are additionally **never reused** — delete `ana` and the next
one gets `ana_2`, because the retired row still holds the name. Directory slugs
*are* reusable, and the reason is worth knowing before you change it: a
directory can only be deleted while empty, so nothing can be pointing at
`d/backend` at the moment it dies. **That exemption rests entirely on
`delete_directory` requiring emptiness.** A force-delete or a cascade added
later would break it silently.

For anything still filed at a departed person's root: Anything of theirs still filed there would become the new person's, so
`Accounts::delete_user` sweeps the root. Three outcomes, and a new Placed kind
has to pick one:

| | |
| --- | --- |
| **Cascades** | Workspaces, agent accounts — rows with `user_id` and a foreign key. Deleted with the person, *including ones filed in a directory*: a session is an agent run under somebody, and its conversation, the subscription it spent and the git identity on its commits do not outlive the account. |
| **Moves** | Machines, to `d/shared` — twice, because the unique index would refuse a name collision and a delete that dies on one is a person nobody can remove. Compute is real and somebody is still running on it, so a person leaving hands their machines to the organisation rather than taking them away. |
| **Goes** | Their secrets. Nothing else can open one, and a token nobody can rotate is worse than no token. |

Only the first is the database's; the other two are `delete_user` doing by hand
what no foreign key can express. The Remove dialog says all three out loud,
because a directory makes it look otherwise.

---

## 4. Who may decide

Two kinds of administrator, and they are not the same one.

**An administrator of the organisation** manages people and teams, and can see
every directory *listed* — including ones they hold no grant in, so a directory
whose last administrator has left is fixable by somebody.

**An administrator of a directory** decides who reaches what is filed in it.

An org administrator is deliberately not given the second by holding the first.
Seeing inside somebody's directory means granting yourself access, which leaves
a row with your name on it in a list everybody with access can read. The
alternative is somebody who can open every conversation on the installation
without anybody being able to tell.

The installation's own secrets — `firetower/ssh-identity`, the OAuth client id —
are the organisation administrator's alone. One of them opens every machine in
the fleet.

---

## 5. The schema, in one place

```sql
principals (id, org_id, kind, slug, name, retired_at)   -- never deleted
users (id → principals, org_id, username, …)
teams (id → principals, org_id, name, everyone, created_by)
team_members (team_id, user_id)
directories (id, org_id, name, slug, created_by)
grants (directory_id, subject_kind, subject_id → principals, level, granted_by)

create view directory_access as …               -- the three routes in, max()

alter table workspaces     add column path ltree not null;
alter table hosts          add column path ltree not null, created_by …;
alter table agent_accounts add column path ltree not null;
alter table secrets        add column path ltree,          created_by …;
```

**A principal is never deleted.** Removing somebody deletes their `users` row —
the cascades take their sessions and memberships — and sets `retired_at` on the
principal. Three things rest on that:

1. **A slug is never reissued.** An exception on somebody else's resource,
   `{"u/ana": "writer"}`, outlives Ana entirely and nothing in the database can
   reach into a JSON blob to clean it up. Sweeping those entries is hygiene; the
   retired row is the guarantee.
2. **`created_by` is never nulled by a departure.** It points at `principals`,
   so "who added this machine" survives them. NULL means only that the row
   predates the column.
3. **`grants.subject_id` has a real foreign key**, because a user and a team are
   both principals. What the database still cannot check is whether they have
   *left* — that is `Access::exists`, and `directory_access` joining `users` is
   what makes a departed person's grants resolve to nothing.

Deleting a user or a team must still delete its grants: they do not cascade,
because the principal they point at is never deleted.

`directory_access` resolves the three routes — granted directly, in a team that
was granted, in the team that is everybody — and takes `max`. That is why two
grants never need a tie-break rule: the most access anybody was deliberately
given is what they have. The database compares the numbers; `Level::rank` in
Rust is what gets interpolated into the predicate, and the two have to agree.

`repos` has a path, and it is the one kind that never moves. Always
`u/<slug>`, never a directory.

This was argued the other way once and written down here as "a repository is
the organisation's and always has been". The fact was right — what opens one is
the token of whoever connected it — and the conclusion was backwards. Left
outside the model, `repos` had no path, so no `filed_where`, so no filter: the
list was `SELECT *` for anybody signed in, and six handlers never looked at the
caller at all. A member could read, rewrite or delete any repository in the
organisation, including its setup script, which the worker runs in every
session cut from it.

Two consequences worth knowing:

- **One remote per person.** `unique (org_id, remote, path)`, not
  `(org_id, remote)`. The old constraint is what forced the old behaviour:
  the second person to connect `acme/backend` could only be handed the first
  person's row, so the row had to belong to everybody. Two people on one
  codebase is now two rows, each with its own setup script and variables.
- **`FiledKind::Repository` is not filable.** `may_share` refuses it by name
  before it reaches the question about roots, because "a repository belongs to
  whoever connected it" is a better sentence than one about personal paths.
  It is still in `FiledKind` so that what somebody owns, and what removing them
  destroys, is drawn from one list.

`added_by` is `on delete cascade`. Everything personal is destroyed rather than
handed on when its owner goes, and the database says so itself so that no code
path can forget.

---

## 6. What an upgrade does

Nothing anybody notices, which is the requirement.

- Every person gets a slug from their username, deduplicated with a number.
- Workspaces and agent accounts go to whoever made them: `u/<them>/…`.
- Machines go to the administrator who set the installation up — the earliest
  one. Nothing recorded who added them, and a machine is personal until somebody
  shares it. They were reachable by everybody before this, so on an install
  where several people shared a fleet, nobody else can start work on it until it
  is filed into `Shared` — which the migration has already created and granted
  to everyone, so that is one move on one screen. The trade is a worse first
  minute after an upgrade against never silently publishing a machine somebody
  added with their own key.
- A secret somebody authorized is theirs. Attached ones — `agent`, `env:`, the
  install's own — get no path.
- `hosts.created_by` stays null on rows that already exist. Nothing recorded who
  added a machine, and putting the first administrator's name on a decision they
  may not have made is worse than saying nothing.

From then on a machine is **personal by default**: it lands at `u/<whoever added
it>/…` and sharing it is a deliberate act with a screen behind it.

---

## 7. Crypto, because a secret is not a row you can move

The vault seals a value against an `Identity { scope, name, owner, version }`,
and the owner is in the associated data of **both** layers — the key wrap and
the value. Move the row to another owner and neither opens. There is no way to
recompute an AEAD tag without the plaintext.

So a transfer is open-then-seal, with a fresh key, a fresh nonce and
`version + 1` — `Vault::hand_over`, which logs it. That is the protection
working, not a limitation: it is what stops somebody with write access to the
database moving a row into another person's name and reading it.

Two things follow:

- **The owner half of a vault key is not "the person asking" and not always
  `user_id`.** Read it back from the row. `Account::credential()` is that, and
  every place that built a key by hand instead reported a connected
  subscription as needing to be set up.
- A version bump means an older copy of the ciphertext cannot be put back and
  pass as current.

---

## 8. Five mistakes, all of which have been made here

**A query without the predicate.** `list_hosts` returned every machine on the
installation to everybody, because it called `Db::hosts` — the fleet's
unfiltered read — from a request handler. Grep for the unfiltered pair before
you use one.

**A mutation gated by a read.** Every session mutation went through
`session_of`, which passes at `Viewer`. A colleague given a look at a directory
could end the sessions in it. If your handler changes something, it asks the
`Writer` method; there is a test named
`a_viewer_can_watch_a_session_and_not_work_in_it` that pins this.

**Assuming an owner instead of reading one.** `credential_set` was computed as
`owner = a.user_id`, which was true until an account could change hands.

**Deciding in the client what the server decides.** Four screens worked out for
themselves whether to offer "move this", and got four different answers — two of
them read a `u/` prefix as *mine* when it only means *somebody's*, and the
sharing dialog did not ask at all, so a viewer was offered "move this into your
own space" and got a refusal when they took it. A control that is offered and
refused reads as a broken button rather than as a permission you do not have.
`mayMove` in `desktop/src/filing.ts` and `web/src/filing.ts` is now the one
answer, and it mirrors `may_share`. If you add a screen that offers a move, call
it; if you change the rule, change it in three places and say so in the commit.

**A query that forgot a column, and a row reader that panicked over it.**
`directory_by_slug` did not select `level` — reasonably, since it has no person
to answer it for — and `directory_from_row` read it with `get`, which panics.
Every request that reached it died with an empty reply, and the one that reaches
it is *a member asking to move something*: an administrator is answered a line
earlier and never gets there, so it survived a full pass of manual testing done
as an administrator. Optional-by-query columns are read with `try_get`.

**A rule that defends the wrong thing.** `keep_an_administrator` counted the
*other* administrators without first asking whether the subject was one — so the
shared directory a first boot makes, which has a writer grant and no
administrator at all, refused every grant on it forever. The locked room the
rule exists to prevent is easier to cause than to prevent.

---

## 9. Where to look

| | |
| --- | --- |
| `crates/ft-core/src/path.rs` | `ResourcePath`, `slug`, the two roots |
| `crates/ft-core/src/grants.rs` | `Level`, `SubjectKind`, `rank` |
| `crates/ft-server/src/access.rs` | `filed_where`, directories, grants, `transfer` |
| `crates/ft-server/src/api/access.rs` | the endpoints, `may_share`, `file_items` |
| `desktop/src/filing.ts`, `web/src/filing.ts` | `mayMove` — what the clients draw, mirroring `may_share` |
| `crates/ft-server/src/vault.rs` | `hand_over`, `names_for`, `owner_for` |
| `migrations/server/…people_teams_and_paths.sql` | the schema, with the reasoning |
| `docs/teams-and-directories.md` | the same thing for somebody using it |
