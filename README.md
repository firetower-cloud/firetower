# Firetower

**Run any coding agent, on your own servers, from anywhere.**

Firetower is a control plane for coding agents. Give it a server you can SSH into and a repository, describe some work, and it picks a host, cuts a branch, makes a worktree, starts tmux, launches the agent, and keeps it running. Attach from a browser or a phone, answer questions, review the diff, ship the branch, destroy the workspace.

It runs on your own machine. No account.

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

Early, but the loop is closed. A session can run on this machine, in a container, or on a server you SSH into. You attach in the browser, answer it, review the diff, and ship the branch. It does not need a repository — an agent can start in an empty workspace.

- [x] Control plane, worker daemon, and the protocol between them
- [x] This machine, a container here, and a server over SSH
- [x] Repository mirrors, per-session worktrees, and sessions with no repository
- [x] An event log on the worker, so a session survives the laptop sleeping
- [x] The agent's terminal in the browser
- [x] Encrypted credentials, and whether each agent is present on a host
- [x] Diff, push, and opening a pull request
- [x] HTTP API with a generated contract
- [ ] A hosted control plane — the worker still never dials out

## Running it

Docker, and nothing else. Everything is in one image: the control plane, the
interface compiled into the binary, and what a session needs to run.

```sh
curl -O https://raw.githubusercontent.com/firetower-cloud/firetower/main/deploy/firetower.yml
curl -O https://raw.githubusercontent.com/firetower-cloud/firetower/main/deploy/Caddyfile
curl -o .env https://raw.githubusercontent.com/firetower-cloud/firetower/main/deploy/.env.example

# fill in POSTGRES_PASSWORD, and FIRETOWER_ROOT_KEY if you want the key off disk
docker compose -f firetower.yml up -d
```

Then read the log. The first start makes an administrator and prints the
password once — set `ADMIN_INITIAL_PASSWORD` in `.env` beforehand if you would
rather choose it:

```sh
docker compose -f firetower.yml logs firetower
```

```
  There was no administrator, so one was made:

    username  admin
    password  velvet-timber-harbor-332
```

Sign in with it and Firetower asks you to replace it — the one it printed was
in a log, and the one you might have set is in a file.

**Sessions run in that container**, the same way they run on a laptop: the
control plane starts a worker as a child process and `localhost` is a real host
in the fleet. To run them somewhere else instead, add that machine over ssh —
see below — and drain `localhost`.

**Only Caddy publishes a port.** The control plane holds every credential
Firetower has and is reachable from nothing but the proxy in front of it, which
matters more than the certificate does.

### Putting it on a domain

With no `DOMAIN` set, Firetower serves plain HTTP on port 80 — right for
something you only reach from that machine. Naming a domain is what turns on
HTTPS, and Caddy does the rest: it gets a certificate, renews it, and redirects
80 to 443.

**1. Point a domain at the machine.** An `A` record for
`firetower.example.com` to its public address, and `AAAA` if it has IPv6. Check
it before starting anything:

```sh
dig +short firetower.example.com
```

That should print the machine's address. Propagation is minutes, not instant.

**2. Open 80 and 443.** Both. Port 80 is not optional even though nothing is
served on it — it is how Let's Encrypt proves you own the name. On a VPS, the
provider's firewall is the one people forget.

**3. Set the domain** in `.env`:

```sh
DOMAIN=firetower.example.com
FIRETOWER_PUBLIC_URL=https://firetower.example.com
```

**4. Start it, then wait.** The first certificate takes 5–30 seconds. Until it
arrives the browser shows a TLS error, which looks like a broken deployment and
is not. `docker compose -f firetower.yml logs -f caddy` says
`certificate obtained successfully`.

**5. If it doesn't work**, the log says which of four things happened:

| In the caddy log | What it means |
| --- | --- |
| `no such host`, NXDOMAIN | DNS isn't pointing here yet |
| timeout or refused on the challenge | port 80 is blocked upstream |
| `too many certificates already issued` | rate limit — see below |
| `unauthorized` on the challenge | the name resolves somewhere else |

**6. Use the staging CA while fixing DNS.** Failed validations are limited to
five per hostname per hour, and it is easy to burn that. Let's Encrypt's
staging endpoint issues untrusted certificates with far looser limits: add
`acme_ca https://acme-staging-v02.api.letsencrypt.org/directory` to a global
block in the `Caddyfile`, prove the pipeline works, then take it out.

**No public domain?** Port 80 has to be reachable, so a machine behind CGNAT or
a closed firewall cannot use this path. Caddy can prove ownership through your
DNS provider's API instead, which needs a plugin compiled into it — open an
issue and we'll document it.

**Expiry warnings.** Let's Encrypt emails before a renewal that has started
failing. To get them, add `email you@example.com` to a global block at the top
of the `Caddyfile`.

### Backups

Two things, and they must be kept apart:

```sh
docker compose -f firetower.yml exec postgres pg_dump -U firetower firetower > firetower.sql
docker compose -f firetower.yml exec firetower cat /var/lib/firetower/root.key
```

The database holds every credential, sealed. The root key is what opens them.
A backup of the database on its own opens nothing — that is the entire point,
and storing the key beside it gives it away. Losing the key means adding every
credential again.

The worker's repositories and worktrees are not a backup target: they rebuild.

### Upgrading

```sh
docker compose -f firetower.yml pull
docker compose -f firetower.yml up -d
```

Migrations run at start-up. **Drain a host before recreating its container** —
recreating takes the tmux server with it, and running sessions go too.

### Already running a proxy?

Delete the `caddy` service, publish `4400` from the `firetower` service, and
point your proxy at it. Two things it has to do that some proxies do not by
default: forward the `Upgrade` and `Connection` headers, or the terminal will
not attach; and not buffer responses, or the session list freezes until
something else forces a flush (nginx: `proxy_buffering off`).

If you trust a header for identity, make sure 4400 is reachable from nothing
but the proxy — see **Who may use it** below.

### Who may use it

Firetower is not open to whoever reaches the port. There are two ways in and a
deployment picks one:

**Signing in.** The administrator is created before anything is listening —
from `ADMIN_USERNAME` and `ADMIN_INITIAL_PASSWORD`, or invented and printed
once. There is deliberately no moment where a fresh Firetower on a public
address is unclaimed, waiting for whoever reaches it first to become its owner.

Either way you are asked to replace that password on the first sign-in, and
until you do, the account can do nothing else. Afterwards the variables are
ignored, so editing an unrelated line of your `.env` cannot reset it. Changing
a password signs out every browser, including the one that changed it.

Forgotten it? There is no reset email, and one supported way back in:

```sh
docker compose -f firetower.yml exec firetower firetower passwd admin
```

**Or a header from a proxy that already authenticates** — Cloudflare Access,
Authelia, oauth2-proxy, Caddy's `forward_auth`. It has to name somebody who
exists here, so a misconfigured proxy cannot admit a stranger as themselves:

```sh
FIRETOWER_TRUSTED_PROXY_HEADER=X-Forwarded-Email
FIRETOWER_TRUSTED_PROXY=172.16.0.0/12
```

The header is believed only from an address in that list, and setting one
without the other stops start-up — a deployment that thinks it is
authenticated and is not would test perfectly, because the tester sets the
header too.

Firetower refuses to listen on anything but loopback with authentication turned
off.

### Adding a server

A server is a machine you already have. Firetower reaches it over ssh with the
key you already use, runs the worker there, and installs nothing you didn't put
there.

You need two things on that machine: an ssh account, and the worker container.
Everything the worker uses is inside that container — git, tmux, Node and an
agent — so there is nothing else to set up.

#### Start the worker

On the machine:

```sh
docker run -d --name firetower-worker \
  --restart unless-stopped \
  -v firetower:/var/lib/firetower \
  ghcr.io/firetower-cloud/firetower-worker:latest \
  sleep infinity
```

The container does nothing on its own. Firetower ssh-es to the machine and runs
`docker exec` when it wants to talk, so there is no sshd in the image, no key
inside it, and no port to open.

If you'd rather keep it in a file, there is a compose file — it needs the Compose
plugin, which a plain Docker install doesn't always have:

```sh
curl -O https://raw.githubusercontent.com/firetower-cloud/firetower/main/deploy/firetower-worker.yml
docker compose -f firetower-worker.yml up -d
```

Check that the account you'll connect as can reach Docker, because Firetower will
be that account:

```sh
docker ps
```

If that says permission denied, add the account to the `docker` group
(`sudo usermod -aG docker $USER`) and log back in.

#### Add it in Firetower

**Compute → Add compute → A server**, then the address, the account to ssh as,
the private key, and the container name — `firetower-worker`, already filled in.

If it doesn't connect, the host is added anyway and says what to fix. Sort the
machine out and press **Try now**; there is nothing to re-add.

**There are no secrets in the compose file, and there never will be.** What an
agent authenticates with is held by the control plane and handed to a session as
it starts, so a fresh container needs no login and the file is safe to paste
anywhere.

#### If your provider builds the VM from our image

Some providers let you create a VM by naming a container image instead of an
operating system. That works, and there is still nothing to install.

Once the VM is up, ssh in and run:

```sh
docker ps
```

**If you see a container** running the worker image, the provider named it — copy
that name into the container field when you add the host.

**If there is no `docker` command** and git and tmux are already there, you are
inside the worker itself. Add the host and leave the container field **empty**.

#### Upgrading

**Drain the host first, and wait.** Compute → the host → **Drain**, until
nothing is running on it. Recreating the container takes the tmux server with
it, and every session on that host goes too. This is the only step here that
can lose work, which is why it comes before the commands rather than after
them.

Then, on the machine:

```sh
docker pull ghcr.io/firetower-cloud/firetower-worker:latest
docker rm -f firetower-worker
docker run -d --name firetower-worker \
  --restart unless-stopped \
  -v firetower:/var/lib/firetower \
  ghcr.io/firetower-cloud/firetower-worker:latest \
  sleep infinity
```

**Keep the volume exactly as it is.** `firetower:/var/lib/firetower` holds
everything worth keeping — repositories, worktrees, the event log, and the
agent's own home, which is where the hooks Firetower installed live. Removing
the container is safe precisely because none of that is in it.

Resume the host afterwards: the same button now says **Resume**.

`latest` is the newest release. Firetower compares its own version against each
worker's on every connection and says when they have drifted, so name a version
instead — `:0.3.0` — if you would rather decide when a worker moves.

**A worker that is behind still works, quietly.** It runs sessions perfectly
well; what it cannot do is anything added since it was built. A worker older
than agent hooks, for instance, will start an agent and never tell you it
stopped — the session simply sits on *working* while the agent waits for you.
Nothing reports an error, so the version drift the fleet screen shows is the
thing to look at when a feature seems not to exist.

### Connecting repositories

Pasting a URL or a path works with no setup: the worker uses whatever git
credentials the machine already has, so if `git ls-remote <url>` works in your
terminal, it works here.

To authorize GitHub instead and pick from a list of your repositories,
Firetower needs an application to authorize *as*. **It asks you for one when you
need it** — the setup wizard offers it, skippably, and the connect-a-repository
screen offers it again at the moment you press *Authorize GitHub* with none
registered. Both walk through the four steps below, and what you paste is kept
in the database and works immediately, with no restart and nothing in a file.

The steps, for reference:

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
   every authorization fails with the same error as a wrong identifier, because
   GitHub answers both with a 404.

5. Copy the **Client ID** from the top of that page, and paste it into
   Firetower.

   Ignore the client secret. This flow doesn't use one, and it shouldn't be
   pasted anywhere. A device-flow client ID is public by design — there is no
   paired secret, which is exactly why this flow suits a program that ships as
   source.

[new-oauth]: https://github.com/settings/applications/new

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
FIRETOWER_ROOT_KEY=$(openssl rand -base64 32)

# 2. otherwise ~/.firetower/root.key, mode 0600, created on first run.
```

44 characters ending in `=`. Anything else stops start-up rather than being
used — a key that is not a key would seal every credential under junk, and
finding that out later is worse than finding it out now.

Back it up separately from the database. A database backup on its own opens
nothing, which is the point — and losing the key means adding every credential
again, which is the same point from the other side.

Reads are logged with the reason they happened, and each entry carries a
fingerprint of the one before it, keyed with the root key. Editing or deleting a
row directly in the database breaks the chain, and the Secrets screen says so.

Not the system keychain, which was the first design: a keychain belongs to one
machine and one signed-in human, and Firetower hands credentials to workers on
other machines and to containers with no desktop session at all.

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

**The worker never opens a port.** It reads frames from stdin and writes them to stdout, so who dials is a transport detail — a child process, `docker exec -i`, or `ssh host firetower worker --stdio`. The daemon can't tell the difference.

`localhost` is a real host, not a special case. It appears in the fleet, runs sessions, and can be drained.

## Working on it

Building Firetower rather than running it is a different set of tools and
a different set of commands. They live in [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

AGPL-3.0-only. Copyright © Westlabs LLC.

If you run a modified Firetower as a network service, you have to publish your changes.
