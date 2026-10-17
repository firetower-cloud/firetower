# Git hosts

A **git host** is somewhere Firetower clones from and pushes to. There can be
any number of them, of three kinds, and more than one of the same kind — a
personal GitHub and a work one, two GitLabs, a GitHub Enterprise beside
github.com.

| | Clones and pushes | Opens requests | Reads issues | Ways to connect |
|---|---|---|---|---|
| **GitHub** — github.com and Enterprise Server | yes | pull requests | yes | browser, token |
| **GitLab** — gitlab.com and self-managed | yes | merge requests | yes | browser (17.9+), token |
| **Gitea** — and Forgejo | yes | pull requests | yes | token |

## Two halves, and why

What is compiled in is the **kind**: the dialect of the API, the shape of the
URLs, what the host calls a request to merge a branch, which ways of signing in
it has. Three of them, in `crates/ft-server/src/providers.rs`.

What is a row is the **connection**: which instance, at which address, with
which OAuth application. It has to be a row — a GitLab somebody runs themselves
is reachable at a name only they know, and there can be more than one.

The **token** belongs to neither. It is in the vault at `git/<id>/<owner>`, one
per person per connection, because a commit has to be attributable to a person.
Two people on one Firetower each connect the same host as themselves and each
see only their own repositories.

So: **adding a host is an administrator's, connecting one is anybody's.** The
address and the application decide what everybody here authorizes against next;
the token is yours.

## Adding one

**Configuration → Git hosts → Add a host**, on the desktop. Pick the kind,
give the address, name it.

The address is reached before anything is saved, and what comes back decides
what the screen offers. This is the whole reason that step exists: GitLab's
device authorization flow arrived in **17.9**, and an instance older than that
answers an attempt with a refusal that reads exactly like a wrong client id. Ask
the instance its version and that becomes a sentence instead — *"GitLab 16.11
has no device authorization flow — it arrived in 17.9 — so everybody connects
this one with a token of their own."*

Not being able to reach it is not a refusal. A control plane briefly off the
network it shares with somebody's GitLab can still record where that GitLab is.

### Naming it

Two hosts may share an address — a personal and a work GitHub are two
connections on `github.com` — but then they must be named differently, because
the list is the only place anybody picks between them. The address is shown
under the name on every row for the same reason.

## The two ways to connect

**In a browser** — the device authorization grant. One OAuth application is
registered for the whole installation, each person approves a short code on the
host, and each gets their own token. Nothing has to be publicly reachable, which
is what makes it work identically on a laptop and on a server with no inbound
ports.

**A token each** — everybody makes a personal access token on the host and
pastes it. Nothing to register.

**The browser is offered first wherever the host has one**, and a token is the
fallback rather than its equal — one screen, with a link under it, not a pair of
buttons. But the fallback is reached for more often than that makes it sound:

* **Gitea** implements the authorization code grant and no device flow at any
  version, so there is nothing to offer it.
* **A GitLab older than 17.9** has none either, and a self-hosted one is as
  likely to be 16.x as 17.11.
* **`disable_admin_oauth_scopes`** stops administrators approving the scopes
  Firetower asks for — see below, and the person installing Firetower on a
  self-managed GitLab is usually an administrator.
* **The shared application's 50 authorizations an hour** can be full, and an
  organization that reviews third-party OAuth applications can refuse ours
  outright.

A pasted token is tried before it is stored, and the account it belongs to is
shown back — so "connected" means the host agreed, not that a string was saved.

### What a pasted token has to be allowed to do

GitHub and GitLab take their scopes as query parameters, so the link Firetower
opens arrives with the right boxes already ticked — `repo` and `workflow` on
GitHub, `api` and `write_repository` on GitLab.

**Gitea cannot pre-tick anything**, and its scopes do not follow from what
Firetower does. Under **Settings → Applications → Manage Access Tokens →
Select permissions**:

| Permission | Set it to | Why |
|---|---|---|
| `user` | Read | `/user/repos`, which is the repository picker, and `/user` for the commit identity |
| `repository` | Read and Write | cloning, pushing a branch, opening and amending a pull request |
| `issue` | Read | reading issues and pull requests on the Tasks screen; cloning and pushing do not need it |

**`user` is the one people miss**, and missing it fails in the least helpful
way available: the token connects, the account name comes back, and the
repository picker is empty — because listing your own repositories is a *user*
endpoint in Gitea, not a repository one, and no amount of repository access
substitutes. Checked against a running 1.22: `read:repository` alone answers
`/user/repos` with 403.

`repository` at Read rather than Read and Write is the other one. It clones a
private repository perfectly well and then refuses the push with a bare
`Forbidden`, and refuses `POST /pulls` with a 403 — so the failure arrives at
the end of a session rather than at the start.

### Tokens that expire, and renewing them

**GitLab's OAuth tokens last two hours.** The figure is not configurable —
`access_token_expires_in 7200` in GitLab's own Doorkeeper initializer — and the
per-application opt-out was removed in GitLab 15.0. There is no box on the
application form to change it; the form has a name, a redirect URI, the
Confidential checkbox and the scopes, and that is all of it.

So a browser authorization comes back with a `refresh_token` beside the access
token, and Firetower keeps both. Every read of a git token goes through
`api::git_token`, which renews the grant when it is within a minute of lapsing
and stores what comes back. Nobody is asked to sign in again every two hours.

Two details that are easy to get wrong, both checked against a running instance:

* **GitLab rotates refresh tokens.** Spending one revokes it and issues another,
  and presenting a spent one answers `invalid_grant`. So the whole response is
  stored, not just the access token — and renewals are serialized per person per
  host, because two at once would leave one of them holding a revoked token and
  looking, from the outside, signed out for no reason.
* **No client secret is needed** to renew, as long as the application is
  registered as public — which for this flow it has to be anyway.

**GitHub is the other shape.** An OAuth App's tokens do not expire unless
somebody enables *Expire user authorization tokens*, and if they do, the device
flow's tokens can still be refreshed without the secret. Either way it works,
and the registration steps do not mention the setting because leaving it alone
is already right.

**A pasted token is whatever its maker chose.** Firetower records no expiry for
one and never tries to renew it; when it lapses the host starts refusing it and
the answer is to paste another. GitLab's personal access tokens have a maximum
lifetime an instance can enforce, so this is worth knowing before picking the
token path on a hardened GitLab to avoid a two-hour OAuth token.

In the vault, a credential with nothing to renew is stored as the bare token,
byte for byte as it always was — which is why every token stored before any of
this existed still reads back correctly. Only a grant with a refresh token or an
expiry is wrapped, and the two are told apart by whether the stored value starts
with `{`.

### The application Firetower ships

**github.com needs nothing registered.** Firetower ships an OAuth application
for it, so a fresh install can authorize in a browser straight away. The client
id is **public by design** — a device-flow application has no paired secret, and
holding it grants nothing. No token ever reaches Firetower's authors: each one
is minted directly to the installation that asked for it and sealed in that
installation's own vault.

Two reasons to register your own instead, both shown on the Git hosts screen:

* **The approval screen carries our name**, and asks for `repo` — which an
  organization that reviews third-party OAuth applications may refuse.
* **The shared application is allowed 50 authorizations an hour**, across every
  installation using it. GitHub counts verification-code submissions per
  application rather than per user. Invisible at a trickle, and hit exactly when
  a lot of people are onboarding at once — so the connect screen says so in
  those words and offers the two ways past it: connect with a token, or register
  an application of your own.

**gitlab.com has one too**, on the same terms.

**And it applies to the hosted instances and nowhere else.** An application
exists on one server, so the one registered on github.com means nothing to a
GitHub Enterprise install, and gitlab.com's means nothing to a GitLab you run
yourself. Those ask for their own and say so, rather than drawing a Connect
button that cannot work. Gitea has no device flow at all, so it never needs one.

### Registering your own

Only for the browser flow, and only once per host.

| Kind | Where | The setting that is easy to miss |
|---|---|---|
| GitHub | Settings → Developer settings → OAuth apps | **Enable Device Flow** — off by default, below the fold, and a disabled one fails exactly like a wrong client id |
| GitLab | Group or user settings → Applications | **Confidential** — ticked by default, and a confidential application refuses the device flow outright: there is no secret to send and GitLab will not proceed without one. |

There is no grant-type setting to find on GitLab: its application form offers a
name, a redirect URI, Confidential and the scopes. Whether the device grant
exists at all is a property of the instance's version, which is what the probe
on the add screen is for.

A GitLab application owned by a *group* is not restricted to that group's
members — any user on the instance can authorize it. Group ownership is worth
preferring anyway, because the application then outlives whoever created it.

It registers the *application*, not a person, so it stays when somebody signs
out and changing it changes it for everybody here.

### When the browser flow is refused on a self-managed GitLab

GitLab has an instance setting, `disable_admin_oauth_scopes`, which stops
**administrators** authorizing any application that asks for `api` or
`write_repository`. Firetower asks for both.

It is off by default, but it is the kind of thing a hardened instance turns on —
and the person setting Firetower up on a self-managed GitLab is often an
administrator. The symptom is a flat *forbidden* on the approval page, which
reads like a Firetower fault and is not one. Connecting with a token of your own
works, and is the answer.

## Signing out, and removing

They are different things with different blast radiuses.

**Signing out** forgets your token. The host stays, everybody else here keeps
theirs, and sessions already running keep the token they were given.

**Removing the host** forgets every token anybody here held for it — they are
that host's and open nothing else. Repositories cloned from it are left alone:
the row is still a real address, and it falls back to being matched by hostname,
which means it keeps working if another host at the same address is connected
and stops finding a token if not. A row pointing at a real remote is worth more
than a tidy database.

**The built-in hosts can be removed, and come back as themselves.** github.com
and gitlab.com each take the well-known id — the literal string `github` — which
is what every key written before this table existed is keyed on. Removing one
and adding it back takes that id *and* the `builtin` flag *and* its place in the
list, so the identities, task keys and API paths that referred to it are adopted
again rather than stranded, the application Firetower ships still applies, and a
client reading the first entry is still reading the built-in host.

Getting that wrong is what made it unremovable for a while: each of the three
was dropped on the way back in at some point, and each left a host that looked
right and behaved like a stranger. Signing out is still almost always what was
meant.

## Which host a repository is on

Two readings, in order:

1. **The row.** A repository picked from a host has that host's id written on
   it. This is what makes two accounts on one hostname work — `github.com` names
   two hosts then, and the remote alone cannot say which token opens this
   repository.
2. **The remote's hostname.** For a remote somebody pasted, and for every row
   written before there was more than one host.

Nothing was backfilled by the migration that added the column. Null means
"match it by hostname", which is exactly what happened before the column
existed — and a guess written into a column outlives the person who could have
corrected it.

## Task trackers

Every git host is also a tracker: an issue is work to pick up and a request to
merge is work to review. They are **derived** from the hosts, with the same id
and the same credential, so adding a GitLab adds a place to read work from with
nothing more to configure and no second token.

Linear is a tracker only, and connects with a key of its own — see
[Task trackers](trackers.md).

### Dialects

GitHub takes one search string and the query box is passed to it verbatim.
GitLab takes structured parameters and a plain search term, so the chips become
fields and the qualifiers people already type are read where they mean the same
thing: `is:open`, `assignee:ana`, `label:bug`, and GitLab's own `state:` and
`labels:`. Anything else becomes the search term. The line under the controls
still shows what was actually sent.

Gitea takes one free-text term and no qualifiers, so whatever was typed is the
term.

## What the words are

GitLab says **merge request**. GitHub and Gitea say **pull request**. The word
comes from the kind and reaches the button, the sequence written above it, and
the line that says one is open — `changeNoun` on the provider status, read once
per screen. `Closes #32` happens to be correct on all three.

## Nested groups

A GitLab project can live inside groups that nest, so `platform/infra/deploy` is
one project three levels down — and GitLab addresses a project by its *whole*
path, URL-encoded. Anything that assumes two segments is wrong there:

* a slug read as "the last two path segments" gives `infra/deploy`, which names
  nothing, and every call made with it comes back 404;
* a merge request's address is `…/platform/infra/deploy/-/merge_requests/12`,
  with a `-` separator that is not part of the path — and older GitLab links
  leave it out.

Both are handled per kind rather than globally, so GitHub and Gitea keep the
two-segment reading, which is right for them.

## Adding a fourth kind

An entry in `KINDS` in `crates/ft-server/src/providers.rs`, and a module each in
`crates/ft-server/src/oauth/` and `crates/ft-server/src/tasks/` implementing
that host's dialect. Dispatch is a `match` on the kind in `oauth/mod.rs` and in
`api/tasks.rs` — three arms, known at compile time, rather than a boxed trait
object that would buy nothing.

What a kind has to answer:

| | |
|---|---|
| `change_noun` | what it calls a request to merge a branch |
| `auth` | the ways in, best first |
| `git_username` | what git is told the username is beside the token; all three hosts ignore it, so it is whatever form that host's own documentation uses |
| `device_path` / `token_path` | the device flow's two endpoints, under the web address |
| `token_page` / `app_page` | where a person makes a token, and registers an application |
| `probe_path` | something cheap under the API root that says what is there |
| `nested_groups` | whether a project path can be more than two segments |
| `hosted` | the instance to offer as a default, if there is one |

A new kind needs no migration: `git_connections.kind` is a text column and not a
foreign key, and a row naming a kind this build does not have is skipped with a
line in the log rather than refused — so downgrading does not strand somebody
who added a Gitea.
