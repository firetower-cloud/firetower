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

## What it cannot simulate

* **macOS.** This is Linux, and one real difference is known: on a Mac, tmux
  keeps its socket under `$TMPDIR` (`/var/folders/…`) rather than `/tmp`, and
  what clears it at boot is launchd rather than a tmpfs. The verdict a worker
  reaches is the same either way — a missing socket and a missing session both
  come back as "no such session" — but it is reasoning, not a measurement.
* **A real power cut.** Docker on macOS is a VM, so there is a layer between
  `docker kill` and the hardware. What a container restart cannot show is a
  filesystem losing its tail: nothing in `crates/` calls `sync_all`, and the
  worker's SQLite runs `synchronous = Normal`, so a machine that genuinely
  loses power can come back having lost the last lines of both. A container
  restart always comes back whole.
* **An agent doing work.** The machine comes up with no agent installed.
  `just sim agent claude-code` fetches one — a download, nothing more — but an
  agent that actually runs a turn has to be signed in, which means a
  credential this harness does not have and real subscription allowance it
  would spend. Everything about the protocol, the fleet, the reconnect and the
  session states can be tested without one; the agent's own resume behaviour
  cannot.

## Getting a browser onto it

The control plane is on `http://localhost:14400` (`SIM_API_PORT` to move it),
with `admin` / `worker-sim-admin`. The API is there from the moment `up`
finishes. There are two ways to look at it, and for anything about a session
the second is the real one.

**The web interface**, compiled into the control plane:

```sh
just sim ui     # builds web/out if it is empty, then restarts the control plane
```

`web/out` is committed empty and the binary embeds it at compile time, so this
builds the export and then forces the control plane to be rebuilt around it.
A minute or two, once.

**The desktop app**, which is where a workspace, a conversation and the
recovery card actually live:

```sh
pnpm --dir desktop dev          # vite, on http://localhost:5273
```

Open it, and add this control plane as a server: `http://localhost:14400`,
`admin`, `worker-sim-admin`. The desktop keeps a registry of servers, so the
harness sits beside whatever else you have without replacing it.

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
offers to bring it back. Then the case that must *not* do that:

```sh
just sim restart-worker worker
```

The worker process goes and comes back; tmux and every agent in it stay
exactly where they were, and no session's status moves.

## How long it takes

Measured on an M2 Pro, first run, nothing cached:

| step | roughly |
|---|---|
| `up`, first time (image builds, then a debug build of the control plane) | 6–10 minutes |
| `up` again, caches warm | 20–40 seconds |
| the worker binary, after the control plane has been built once | 30–60 seconds |
| `kill` | instant |
| `start`, to the machine reading Online again | 10–30 seconds |
| `restart-worker`, to the worker reconnecting | 5–20 seconds |
| `just sim ui`, first time | 2–4 minutes |

The number worth knowing before you decide something is broken is the first
one. `up` compiles this checkout inside the container; it is minutes, and
`just sim logs control` is what to watch while it does.
