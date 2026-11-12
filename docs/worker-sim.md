# A worker in a container

`worker-sim` stands up a Firetower you can break: Postgres, a control plane
built from this checkout, and a Linux machine with an sshd on it that the
control plane reaches the way it reaches any other machine — over ssh, with the
key it made for itself, running a worker installed by `install/worker.sh`.

It exists because the things worth testing about a worker cannot be tested from
a laptop you are also working on. Pulling the plug on a machine, restarting the
worker process without touching tmux, watching a fleet reconnect: all of them
are destructive, and all of them are the behaviour that matters most.

```sh
just sim up                      # the stack, up and registered
just sim kill worker             # a power cut
just sim start worker            # the reboot
just sim restart-worker worker   # the worker process only
just sim down                    # take it away
```

`just sim` on its own prints the list. So does `./worker-sim/run.sh`, which is
what the recipe runs.

## What each command simulates

The names are the point: these are four different failures that look alike
from a distance and are not alike at all.

| command | what it is, on a real machine |
|---|---|
| `kill <container>` | **A power cut.** SIGKILL to pid 1; nothing is asked to stop. The tmux server dies and every agent under it dies with it, mid-sentence. The home directory — the worktrees, the branches, the uncommitted edits, the transcript — is exactly as it was. |
| `start <container>` | **The reboot.** The same machine again, with `/tmp` cleared, no tmux server and no agents. The control plane reconnects on its own backoff and asks the worker to watch every session it believes is live. This is the incident: twelve workspaces intact and twelve agents gone. |
| `restart-worker <container>` | **The worker process only.** `firetower-worker` is sshd's child, so killing it drops the control plane's connection and the supervisor dials again and starts a new one. tmux is *not* its child and does not notice. **Nothing may be stranded by this** — it is the case a wrong fix breaks, and the reason this command exists rather than being left to `docker exec`. |
| `down` | Removes this project's containers and network. `down --volumes` takes the build caches too, which makes the next `up` a full compile again. |

## Safety

This runs on machines that are themselves live Firetower workers, where the
host's tmux server is holding somebody's real work. So:

* **The API is bound to loopback.** A published port with no host address
  binds `0.0.0.0`, and this control plane has an administrator whose password
  is in `run.sh` — so without `127.0.0.1:` it would be a known credential on an
  admin API offered to every machine on the network, from a host that is often
  somebody's live worker.
* **The Compose project is `ft-worker-sim`, hardcoded.** Not taken from the
  environment, not derived from the directory. A project name is the namespace
  for volumes as well as containers, and `firetower` (a deployment) and
  `firetower-dev` (the dev stack) are both taken — see the warning at the top
  of the repository's `compose.yaml` for what sharing one costs.
* **Every destructive command names one container**, resolves it to an id, and
  proves it carries this project's label before anything happens. It prints
  what it is about to do and to what, first.
* **Nothing has a default target.** `run.sh kill` with no argument is a
  refusal and a non-zero exit, not a guess.
* **No `prune`, anywhere, for any reason**, and no `docker compose down` — the
  teardown enumerates this project's containers and removes them one at a time
  by id, because `compose down`'s blast radius is whatever project it resolved.
* **No tmux command runs outside a `docker exec`** into a container the script
  resolved. The container's tmux server is not the host's, and that distinction
  is the whole safety model.

## What it builds, and how to be sure

**The binary follows your editor, not your git history.** The repository is
bind-mounted and the control plane is `cargo run`, so what comes up is the
working tree at the moment it compiles — uncommitted changes included. That is
the right default for developing and a trap for testing: a QA pass on this
feature ran against 551 lines of somebody's unsaved work, and only caught it
because it thought to ask the container.

So `up` prints what it is about to build, every time, and **refuses on a dirty
tree** unless you say you meant it:

```
building   dc0dcf6b fix(sim): loopback only, host keys per machine…
tree       clean — this is that commit and nothing else
```

Three ways to answer it:

```sh
just sim up                                  # a clean tree: this commit, nothing else
just sim up --dirty                          # what you have, knowingly
SIM_REPO=/tmp/clean just sim up              # a clone checked out at the commit under test
```

`just sim status` asks the same question of the running container, which is the
one that cannot be wrong about which checkout is mounted.

## Two things worth knowing about rebuilding it

**A recreated container is a new machine, and Firetower says so.** The host
keys are made on the machine's first start — not baked into the image, where
they would be a private key every container built from it shares — so a
container that is replaced answers with different ones, and the control plane
refuses it: *worker answered with a different host key than last time*. That
refusal is `StrictHostKeyChecking` doing its job. `up` answers it the way an
operator would, by forgetting that one host's key before it reconnects.

**The worker binary goes with the container, not with the volume.** Recreating
the worker loses the install under `~/.firetower`, which is correct — it is a
different machine — and `up` reinstalls it. `down` and `up` is therefore a
fresh machine with the same name and the same sessions pointed at it, which is
a useful thing to be able to make.

## When it will not come up

**"memory map must have a non-zero length"**, or any other `rustc` error about
a file in `/target`, means the build cache was cut off mid-write — a Docker
daemon that restarted under it will do this, and on a Mac that is OrbStack
updating itself. The files are zero-length rather than wrong, and
`cargo clean -p` will not remove them — cargo has no reason to think they are
broken. Delete them by what they are:

```sh
docker run --rm -v ft-worker-sim_target:/target alpine:3 \
    sh -c 'find /target -type f -size 0 -delete'
just sim up
```

Measured at 176 files after one OrbStack restart, and about two minutes to
rebuild what they were. `just sim down --volumes` gets there the long way
round, at the cost of the whole cache.

Worth knowing before you conclude the harness is broken: everything else
survives a daemon restart, because the containers are stopped rather than
removed. `docker start` on each, or another `up`, and the fleet is as it was.

## What it cannot simulate

* **macOS.** This is Linux, and one real difference is known: on a Mac, tmux
  keeps its socket under `$TMPDIR` (`/var/folders/…`) rather than `/tmp`, and
  what clears it at boot is launchd rather than a tmpfs. Both endings are read
  as "there is no server" by `tmux.rs` — a missing socket answers `(No such
  file or directory)` and a socket left behind by a dead server answers
  `(Connection refused)` — but the Linux one is measured here and the macOS one
  is reasoning.
* **A real power cut.** Docker on macOS is a VM, so there is a layer between
  `docker kill` and the hardware. What a container restart cannot show is a
  filesystem losing its tail: nothing in `crates/` calls `sync_all`, and the
  worker's SQLite runs `synchronous = Normal`, so a machine that genuinely
  loses power can come back having lost the last lines of both. A container
  restart always comes back whole.
* **A `/tmp` sweep on a running machine**, which is the one failure that looks
  like a reboot and is not: the sockets go and the processes stay.
  `systemd-tmpfiles` does it on a live system, and every way of asking after an
  agent — tmux's socket and the supervisor's — goes through `/tmp`. The harness
  can empty `/tmp` by restarting the container, but not while the agents in it
  carry on. What answers that case is not the probe: it is the supervisor's own
  lock on the workspace, which the kernel releases only when the process
  holding it dies, so a launch refuses while an agent is alive however
  unreachable it has become. See `agentd::hold`.
* **An agent doing work.** The machine comes up with no agent installed.
  `just sim agent claude-code` fetches one — a download, nothing more — but an
  agent that actually runs a turn has to be signed in, which means a
  credential this harness does not have and real subscription allowance it
  would spend. Everything about the protocol, the fleet, the reconnect and the
  session states can be tested without one; the agent's own resume behaviour
  cannot.

## Getting a browser onto it

The control plane is on `http://localhost:14400` (`SIM_API_PORT` to move it),
with `admin` / `worker-sim-admin`. (It is seeded with a temporary password and
`up` replaces it on the first run, because an account that still has its
seeded password is refused by every endpoint until it does not.) The API is
there from the moment `up` finishes. There are two ways to look at it, and for anything about a session
the second is the real one.

**The desktop app is the one that has sessions on it.** Workspaces,
conversations and the recovery card are desktop-owned; the web page this
control plane serves is the installation as an institution — accounts, the
organisation, where to download the app — and has no session on it at all. So
for anything you were going to photograph, this is the route:

```sh
pnpm --dir desktop dev          # vite, on http://localhost:5273
```

Open `http://localhost:5273` and add this control plane as a server:
`http://localhost:14400`, `admin`, `worker-sim-admin`. The desktop keeps a
registry of servers, so the harness sits beside whatever else you have.

Driving it headlessly — which is what a QA agent does — the registry is two
keys in `localStorage`, exactly as `desktop/scripts/check-states.mjs` seeds
them:

```js
localStorage.setItem("firetower.servers", JSON.stringify([{
  url: "http://localhost:14400", serverId: "o_1", org: "Worker sim",
  user: "admin", token: "<POST /api/v1/auth/login>", addedAt: "2026-11-11T18:00:00Z",
}]));
localStorage.setItem("firetower.current", "o_1");
```

A conversation is at `http://localhost:5273/#/sessions/<session id>`.

The control plane runs in development mode for this: the app on
`localhost:5273` is cross-origin, and in production the allowlist is three
`tauri://` origins because the real app is not a web page. Without it every
call fails and the app draws *Can't reach it — showing what was last known*,
which is how this was found.

**The web interface**, if you want the institutional half:

```sh
just sim ui     # builds web/out if it is empty, then restarts the control plane
```

`web/out` is committed empty and the binary embeds it at compile time, so this
builds the export and then lets the build script rebuild the control plane
around it. Measured at 58s with `pnpm install` already done.

## Reproducing the incident

What the crash-recovery work is tested against, end to end:

```sh
just sim up
# start a session on the worker-sim machine, from the desktop app
just sim kill worker       # the machine goes, mid-turn
just sim start worker      # it comes back; its agents do not
```

Within seconds of the reconnect — and with nobody opening anything — every
session whose agent is gone reads **Machine restarted**, and its conversation
offers to bring it back. Measured: the status moved a second after `start`,
and the reconnect that triggered it is on the supervisor's backoff, 1–35s.
Then the case that must *not* do that:

```sh
just sim restart-worker worker
```

The worker process goes and comes back; tmux and every agent in it stay
exactly where they were, and no session's status moves.

## How long it takes

Measured on an M2 Pro, 10 cores, with Docker's image cache warm and its
volumes empty:

| step | measured |
|---|---|
| `up`, first time — two image builds, the pinned Rust toolchain installing itself, then a debug build of the control plane | **1m 55s**, of which 72s is waiting for the control plane to compile and bind |
| `up` again, nothing changed | **31s** (the control plane container is recreated, 12s to answer) |
| `up` after a Rust change | **1m 10s** — the control plane recompiles, the worker is rebuilt and reinstalled |
| the worker binary on its own, sharing the control plane's artifacts | 4–17s |
| `kill` | under a second |
| `start`, to the control plane reconnecting | 1–35s, on the supervisor's own backoff |
| a session reading **Machine restarted** after that reconnect | under a second |
| `restart-worker`, to a new worker being online | about 1s |
| `just sim ui`, first time | a few minutes (`pnpm install` and `next build`, then the control plane again) |

The number worth knowing before you decide something has hung is the first
one, and the part of it that looks like nothing happening is the compile.
`just sim logs control` is what to watch while it does.
