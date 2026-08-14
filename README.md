# Firetower

**Run any coding agent, on your own servers, from anywhere.**

Firetower is a control plane for coding agents. Give it a server you can SSH into and a repository, describe some work, and it picks a host, cuts a branch, makes a worktree, starts tmux, launches the agent, and keeps it running. Attach from a browser or a phone, answer questions, review the diff, ship the branch, destroy the workspace.

It runs on your own machine. One binary, one directory, no account.

```
$ firetower

  Firetower
  http://localhost:4400
```

---

## Why

Agents block. You are the bottleneck. Firetower's job is to route their blocking to you — wherever you are — and get you back out fast.

That's why the dashboard is an inbox rather than a fleet monitor, and why a session that asked a question, finished a turn, or hit an expired credential all land in the same place. They mean the same thing: *it stopped being useful without you.*

## Status

Early. The first milestone runs sessions on your own machine, which is the whole system with the network taken out of it:

- [x] Control plane, worker daemon, and the protocol between them
- [x] Repository mirrors and per-session worktrees
- [x] An event log on the worker, so a session survives your laptop sleeping
- [x] HTTP API with a generated contract
- [ ] tmux and the terminal in the browser
- [ ] Credentials and agent status
- [ ] Diff, push, pull request
- [ ] Remote hosts over SSH

## Requirements

| | Why |
|---|---|
| **Rust** 1.90+ | Builds everything. `rustup` handles the rest — the toolchain is pinned. |
| **git** | Mirrors and worktrees. Already on most machines. |
| **tmux** | Holds the agent's terminal. This is the piece that keeps a session alive after you disconnect, so it isn't optional. |
| **Node 22+ and pnpm** | Builds the web application. |
| **[just](https://github.com/casey/just)** | Task runner. Every command below assumes it. |
| **cargo-watch** | Rebuilds the control plane on save. Only needed for `just dev`. |

```sh
# macOS
brew install rust tmux node pnpm just
cargo install cargo-watch

# Debian / Ubuntu — pnpm and just aren't in apt
sudo apt install tmux
curl -fsSL https://sh.rustup.rs | sh
curl -fsSL https://get.pnpm.io/install.sh | sh -
cargo install just cargo-watch
```

## Running it

```sh
git clone https://github.com/westlabs/firetower
cd firetower
just doctor     # checks you have the tools
just setup      # installs dependencies, once
cargo run
```

State lives in `~/.firetower`. Delete it and Firetower rebuilds what it can by reconnecting to your hosts — the control plane's database is a cache, not the source of truth.

### Connecting repositories

Pasting a URL or a path works with no setup: the worker uses whatever git
credentials the machine already has, so if `git ls-remote <url>` works in your
terminal, it works here.

To authorize GitHub instead and pick from a list of your repositories, this
build needs an application to authorize *as*. Registering one is a five-minute
job you do once.

#### Registering the application

1. Go to **[github.com/settings/applications/new][new-oauth]** — or navigate
   there: your avatar → Settings → Developer settings → OAuth Apps → New OAuth
   App.

2. Fill in the form:

   | Field | What to put |
   | --- | --- |
   | **Application name** | `Firetower` — this is the name shown on the approval screen |
   | **Homepage URL** | Anything, e.g. `https://github.com/westlabs/firetower` |
   | **Authorization callback URL** | Required by the form, unused by this flow. Put the homepage URL again. |

3. Click **Register application**.

4. On the page that appears, tick **Enable Device Flow**, then **Update
   application**.

   Don't skip this. It's off by default, it's below the fold, and without it
   every authorization fails with *"GitHub rejected this build's application
   identifier"* — the same message you'd get from a wrong identifier, because
   GitHub answers both with a 404.

5. Copy the **Client ID** from the top of that page.

   Ignore the client secret. This flow doesn't use one, and it shouldn't be
   pasted anywhere.

[new-oauth]: https://github.com/settings/applications/new

#### Where the client ID goes

In `.env`:

```sh
cp .env.example .env
# then fill in
FIRETOWER_GITHUB_CLIENT_ID=Ov23li…
```

Restart Firetower and the connect screen offers **Authorize GitHub**.

Two locations are read, nearest first:

| File | For |
| --- | --- |
| `./.env` | a checkout you're working in |
| `~/.firetower/.env` | an installed copy with no checkout |

Real environment variables beat both, so `FIRETOWER_GITHUB_CLIENT_ID=… firetower`
still wins for a one-off.

`.env` is gitignored. Nothing that goes in it is secret — a device-flow client
ID is public by design, with no paired secret — but the file is per-install, so
it stays out of version control.

#### Why an OAuth App and not a GitHub App

Both support the device flow, but this build asks for the `repo` scope and
lists through `/user/repos`, which is the OAuth App model. It also assumes the
token keeps working: GitHub App user tokens expire after eight hours, and
refresh isn't wired up yet.

`repo` is what covers cloning a private repository and pushing the branch a
session works on. If you only ever want public repositories, `public_repo` is
narrower — change `scopes` in `providers.rs`.

#### Where the token goes

Into the secret store — see below. Workers are handed it per operation and hold
it in memory only, so a server that runs your sessions never stores your git
credentials; see `crates/ft-worker/src/askpass.rs`.

### Secrets

Every credential Firetower holds — a git host's token, an agent's token — is
encrypted in the database. The Secrets screen shows what is held and every time
it was touched, and lets you show, replace or remove one.

Showing a credential is logged as `Reveal`, separately from a session using it.
Worth knowing what that costs: anything that can reach the API can read every
token, so the log is what is left to notice it happening.

The shape is ordinary envelope encryption. Each secret gets a key of its own;
that key encrypts the value; a **root key** encrypts that key. Both layers are
bound to the secret's scope, name and version, so a row moved to another name or
restored from before a rotation fails to open instead of quietly handing back the
wrong credential. The cipher is XChaCha20-Poly1305.

**The root key is not in the database.** It comes from one of two places:

```sh
# 1. an environment variable — for containers, servers, anything with a key
#    manager in front of it. Nothing is written to disk.
FIRETOWER_ROOT_KEY=<base64, 32 bytes>

# 2. otherwise ~/.firetower/root.key, mode 0600, created on first run.
```

Back it up separately from the database. A database backup on its own opens
nothing, which is the point — and losing the key means adding every credential
again, which is the same point from the other side.

Reads are logged with the reason they happened, and each entry carries a
fingerprint of the one before it, keyed with the root key. Editing or deleting a
row directly in the database breaks the chain, and the Secrets screen says so.

Not the system keychain, which was the first design: a keychain belongs to one
machine and one signed-in human, and Firetower hands credentials to workers on
other machines and to containers with no desktop session at all.

### Working on it

The web application has its own dev server, so development runs two processes:

```sh
just dev        # control plane on :4400, web application on :3000
just test
just gen        # regenerate the API contract and the typed client
```

While developing, the interface and the control plane are two processes on two
ports, so the interface has to be told where the API is. That lives in
`web/.env.development`, which is committed. If every request 404s from Next
instead of reaching the control plane, that file is why — the interface is
asking itself.

In production there's one process and the API is same-origin, so none of this
applies.

The web application is pinned to pnpm. Running `npm install` in `web/` would
produce a second lockfile, so `packageManager` refuses it.

`.env.example` is for contributors. Nobody running Firetower needs one.

## How it fits together

```
   your machine                              a host
   ┌────────────────────────┐                ┌──────────────────────┐
   │ firetower              │                │ firetower worker     │
   │                        │   frames over  │                      │
   │ web application        │◀──any stream──▶│ git · tmux · agents  │
   │ scheduling             │                │ its own event log    │
   │ hosts · repos · creds  │                │                      │
   └────────────────────────┘                └──────────────────────┘
     owns what should happen                   owns what happened
```

**Workers are authoritative.** They record what happened before reporting it, so closing your laptop costs nothing: when it comes back, it asks for everything since the last thing it saw.

**The worker never opens a port.** It reads frames from stdin and writes them to stdout, so who dials is a transport detail — a child process today, `ssh host firetower worker --stdio` next, something else later. The daemon can't tell the difference.

`localhost` is a real host, not a special case. It appears in the fleet, runs sessions, and can be drained.

## Licence

AGPL-3.0-only. Copyright © Westlabs LLC.

If you run a modified Firetower as a network service, you have to publish your changes.
