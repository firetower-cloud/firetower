# Teams, directories and who can see what

Until now a Firetower with five people on it was five people who could not see
each other's work. A workspace carried the id of whoever started it and every
read asked "is this yours" — a complete answer to that question and no answer to
"may I see yours".

## Everything is somewhere

Every workspace, machine, subscription and secret is filed at a **path**, and
where it is filed is who can reach it. There are two kinds of place:

```
u/kevin/ledger-rounding      Kevin's own space. Nobody else, ever.
d/backend/ledger-rounding    the Backend directory. Whoever it is shared with.
```

Nobody types one. The path is what the product stores; what you see is a chip
saying *yours* or *d/backend*, and a menu to change it.

Your own space needs no setting up and cannot be shared as a whole — it is not a
folder somebody could hand you the key to. It is simply where your work is until
you decide otherwise.

## The three nouns

**A person** is a user account.

**A team** is a named group of people. It exists so that access handed to five
of them is one row rather than five that drift apart the moment somebody joins.
One team, `Everyone`, is every person in the organisation; it has no membership
rows at all, because the membership that has to be true is "however many people
exist right now".

**A directory** is a named place to put work so that other people can reach it.
`Backend`, `Q4 launch`, `Shared`.

**A grant** is: a person or a team, may look or work or administer, in a
directory.

| | |
| --- | --- |
| **Viewer** | Find it, open it, read what happened. |
| **Editor** | Also start an agent, answer one, use the terminal, ship. |
| **Admin** | Also decide who else can, and what is filed there. |

A grant applies to everything filed under that directory, however deeply it is
named. Somebody can arrive by several routes at once — named directly, and in
two teams that were both granted — and the most access they were deliberately
given is what they have.

## Filing something hands it over

This is the one rule worth reading twice.

Moving a workspace into `Backend` gives it to `Backend`. You keep it through
whatever grant you hold there, and if you hold none you no longer have it. The
product says so every time it offers the move: *"Everybody with access to
d/backend can open it — and it becomes theirs."*

The alternative — a thing that lives in a directory and still belongs to you —
means two answers to "who decides about this", and the day they disagree
somebody is locked out of their own work by a rule nobody wrote down.

Taking something back out puts it in **your** own space, which is the same rule
read backwards. That needs admin on the directory it is coming out of: a writer
can put things in and cannot take somebody else's out.

Firetower always records **who made a thing**, and that survives it changing
hands. It is shown on the Access screen as "Made by". It is a fact about
history, not a key to anything.

## What an upgrade does to an installation that already exists

Nothing anybody notices.

Everything you have made becomes yours — filed in your own space, visible to
exactly the people it was visible to yesterday, which is nobody. Machines are
the exception, because they were already shared: they go into one `Shared`
directory that the `Everyone` team may work in, which is exactly what compute
has always been. On a Firetower with one person on it there is nobody to share
with, so those become theirs too.

## Sharing your own work

Anybody can make a directory, and whoever makes one administers it. Deliberately
not an administrator's errand — sharing your own work is the reason the feature
exists, and making it a request to somebody else is how it comes not to happen.

Teams are the other way round: who is in one is a fact about the organisation,
and granting is only worth doing against a membership list that can be relied
on. So **Organisation → Teams** is an administrator's and **Organisation →
Access** is everybody's.

A workspace can be filed somewhere shared when it is created — there is a
**Filed in** row on the new-workspace form — or moved afterwards from the share
button in the workbench. Moving one changes who can see it and nothing else: the
worktree, the branch and the agents running in it stay exactly where they are.

## Machines

A machine you add is **yours** until you share it. That is the same default
everything else gets, and it is the safe one: a server added with your own key
is not reachable by the whole organisation before you have decided it should be.

Share it by filing it in a directory, exactly like a workspace. The `Shared`
directory that comes with a fresh installation is where the fleet's own machines
live; everybody can work on those, and taking one out needs admin on `Shared`,
so nobody can pull it out from under the people running on it.

## Working in somebody else's workspace

A workspace holds any number of agents, each its own session with its own owner.
So a colleague with writer access does not take over your agent — they start
**their own**, in the same worktree, on the same branch, running on their own
subscription and committing under their own git identity.

A viewer can watch and cannot touch: not end a session, not rename one, not send
it a turn, not open a terminal in it.

The terminal is the one thing that cannot be split: tmux is a shell on the
machine the work is running on, with that machine's access to everything. Writer
includes it. That is the widest door in the system and it is worth knowing where
it is.

## Lending a subscription

An agent account is filed like everything else, so putting yours in a directory
lets that team pick it for their own runs.

Its credential goes with it. Firetower re-encrypts the token under the
directory when the subscription moves, so a borrowed account is one that
genuinely works — while still spending the quota of the subscription it is, with
that account's name on what it does. Renaming, reconnecting and disabling stay
with whoever connected it.

## Secrets

A secret you store is yours, in your own space. Filing one in a directory shares
it with the people who can reach that directory, and Firetower re-encrypts it on
the way: the value is sealed against its owner, so handing one over is a real
transfer and not a second reader being quietly added. Every one of those moves
is a line in the vault's log, with the name of whoever made it.

An agent account's credential and a repository's variables are *attached* — they
belong to the thing they are for and move when it moves. They cannot be filed on
their own, because a subscription in one directory whose token sits in another
is a subscription that does not work.

The installation's own secrets — the SSH identity every worker is reached with,
the OAuth client id — belong to the deployment rather than to anybody in it, and
are an administrator's. One of them opens every machine in the fleet.

## Removing somebody

Their workspaces go with them, including ones they filed in a directory — a
session is an agent run under a person, and its conversation, the subscription
it spent and the git identity on its commits do not outlive the account. So do
their credentials: nothing else can open one, and a token nobody can rotate is
worse than no token.

Machines they added stay. Compute is real and the organisation is still running
on it, so those move into `Shared` rather than disappearing.

If somebody might be back, switch them off instead. That keeps everything.

## Administrators

An administrator of the organisation manages people and teams, and can see every
directory listed — including ones they have no grant in, so a directory whose
last administrator has left is fixable by somebody.

Being an administrator is deliberately **not** a way to read everything. Seeing
what is inside somebody's directory means granting yourself access to it, which
leaves a row with your name on it in a list everybody with access can read. The
alternative is somebody who can open every conversation on the installation
without anybody being able to tell.

A directory cannot be left with nobody to administer it: a directory nobody can
change the grants on is a locked room with things inside it.

## Where the rules live

One place, and that is the point. `crates/ft-server/src/access.rs` holds the
access layer, and `access::filed_where` is the only definition of "this is filed
where they may look" — every read that enforces access builds its predicate from
it. The failure worth defending against is not a wrong design but a query added
next spring that leaves the condition off and quietly returns everybody's rows;
one function with one set of callers is something a reviewer can check by
grepping.

**If you are about to write code here, read [paths and
ownership](./paths-and-ownership.md) first.** It is the same subject for
somebody adding a table or an endpoint, and it lists the mistakes that have
already been made.
