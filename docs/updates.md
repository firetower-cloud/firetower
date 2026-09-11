# Upgrading from the Updates screen

Firetower checks the releases feed every few hours and says, in the rail, when
a newer release is out. Nothing moves until an administrator opens **Updates**
and presses one of two buttons. There is no automatic mode.

## What can be moved from here

| Target | How | Sessions on it |
| --- | --- | --- |
| The control plane | The `updater` container beside it pulls the release, rewrites the deployment files the release changed, runs `docker compose up -d firetower` against the deployment's own `firetower.yml`, and waits for `/readyz`. If it does not answer within three minutes, the previous image is put back. A `pg_dump` is written into `backups/` first. | End when it is recreated. Sessions on other machines keep running under tmux and reconnect. |
| A worker in a container — on a server, or on this machine | The control plane recreates it over the same ssh connection it already uses: `docker pull`, `docker rm -f`, `docker run` with everything the container was created with, read from `docker inspect`. A Compose-managed worker gets `docker compose pull && up -d` in its own directory instead. | End when it is recreated. |
| A worker installed by hand (`firetower-worker` on the PATH, no container) | Not moved. Firetower does not know how it was put there. `firetower worker install` on that machine moves it into a container it can. | — |
| `@firetower/cli` on your own machine | Not reachable. The screen says which version the release wants. | — |

The order in a run is fixed: back up, the updater, the control plane, then each
worker one at a time. A worker newer than the control plane is the same protocol
mismatch as one older, so nothing moves a worker ahead.

## Now, or when idle

**Upgrade now…** lists every session that would end, by name, and asks you to
acknowledge it. Each agent is told to stop before its container is recreated;
worktrees and branches stay, the agents' conversations do not.

**Upgrade when idle** drains every target — nothing new is placed on it — and
recreates each once nothing is running on it. It can be cancelled while it
waits; the targets are put back in service.

## Deployment files

A release may change `firetower.yml`. Before a run starts, the screen compares
three copies: the one on the machine, the previous release's, and the new
release's.

* Unchanged by the release: left alone, whatever you did to it.
* Changed by the release and yours is the previous release's copy: replaced,
  with the previous one kept as `firetower.yml.backup`. The diff is shown.
* Changed by the release **and** edited by you: both diffs are shown — your
  edits, and what the release changes — and you choose: replace it and reapply
  your edits afterwards, or skip the control plane this time and upgrade the
  workers only. Nothing is merged.

`.env` is never written. If the release's `.env.example` adds a required
variable, the screen names it and waits for you to add it. The `Caddyfile` is
compared the same way and, like `firetower upgrade`, is not rewritten.

## The updater

```
firetower ──token──▶ updater ──socket──▶ dockerd
   │                    │
   │                    └── docker compose -f firetower.yml up -d firetower
   └── ssh ──▶ worker machines
```

The updater is a container in `deploy/firetower.yml` with one privilege — the
machine's Docker socket, which is root on that machine — and nothing else: no
key, no password, no database connection, no published port. The control plane
reaches it on the compose network with `FIRETOWER_UPDATER_TOKEN` from `.env`;
the updater refuses everything without that token. It decides nothing on its
own.

An install that predates the updater has no such container yet. The Updates
screen still upgrades workers, and says that one `firetower upgrade` on the
machine adds the updater; after that the control plane can upgrade itself from
the screen.

## Where things are kept

Every run and every step is a row in the control plane's database, with the
commands that were run and what they said — redacted, bounded. That is what
lets the run survive the control plane being recreated in the middle of it:
the new process finds the step that was waiting, asks the updater how the job
went, and carries on with the workers.

Every ssh key materialisation for an upgrade is a line in the vault's access
log, with the run and the machine as its reason.

## Environment

| Variable | Where | Meaning |
| --- | --- | --- |
| `FIRETOWER_UPDATER_TOKEN` | `.env`, read by both services | The shared token. |
| `FIRETOWER_UPDATER_URL` | control plane | Where the updater is; `firetower.yml` sets it. Unset means no updater. |
| `FIRETOWER_NOTIFY_URL` | control plane | Also receives one POST per new release, if set. |
| `FIRETOWER_UPDATE_FEED` | control plane | The `releases/latest` document to read. GitHub's by default. |
| `FIRETOWER_UPDATE_RAW` | control plane | Where release files are fetched from, for the diffs. |
| `FIRETOWER_UPDATER_HELPER_IMAGE` | updater | The image Compose is run from. `docker:28-cli` by default. |
