# Upgrading from the Updates screen

Firetower checks the releases feed every few hours and says, in the rail, when
a newer release is out. Nothing moves until an administrator opens **Updates**
and presses one of two buttons. There is no automatic mode.

## What can be moved from here

| Target | How | Sessions on it |
| --- | --- | --- |
| The control plane | The `updater` container beside it pulls the release from the tag the deployment file names, rewrites the deployment files the release changed, runs `docker compose up -d firetower` against the deployment's own `firetower.yml`, and waits for `/readyz`. If it does not answer within three minutes, the previous image is put back. A `pg_dump` is written into `backups/` first. | End when it is recreated. Sessions on other machines keep running under tmux and reconnect. |
| A worker on a machine | The control plane runs the installer over the same ssh connection it already uses, pinned to the version being moved to. The script fetches the build for that machine's own shape and replaces `~/.firetower/worker/bin/firetower-worker`, and the connection is then dropped — replacing the file does not replace the process holding it open, so the worker has to reconnect for the new binary to be the one serving. | End when it is reinstalled. |
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

## Channels

An installation is on one of two channels, and **its channel is the tag on the
image it is running**. Nothing stores it: the control plane asks the updater
what image its own container was created from and takes the tag. One fact
cannot disagree with itself — a setting saying `beta` beside a compose file
saying `:stable` would drift, and the error you would be shown is about image
versions rather than about the setting that caused it.

| Tag | What it means |
| --- | --- |
| `stable` | **General access** — the version a maintainer has promoted. This is the tag to pin. |
| `beta` | Every release, as soon as it is cut. |
| `latest` | The newest build published. A convention for pulling by hand, **not a channel**: an installation pinned here follows beta's builds without having chosen beta. |
| `edge` | The tip of `main`. Unreleased, and not a channel either. |

Which version each channel holds is a published document — the channel
manifest — rather than something derived by scanning release tags. It names a
version per channel per package, because the control plane and the desktop app
release separately. The Updates screen reads it; nothing here writes it.

Reading it has outcomes that are deliberately not interchangeable, because the
answer to each is different:

| Outcome | What it means, and what to do |
| --- | --- |
| **Absent** | No document yet. The bootstrap case, and the only one that is not a problem: the installation follows the newest release, as it did before channels existed. |
| **Found** | It read. That is the answer. |
| **Vanished** | It was read before and is gone now. The document every installation reads has been destroyed — somebody has to republish it, and waiting makes it worse. |
| **Unreadable** | A rate limit, a network failure, a status that is not a 404, or a body longer than 64 KiB. Worth retrying. |
| **Malformed** | Something came back and it is not this document. |
| **Incomplete** | It is this document and it names no version. |

Everything except absence and a document that reads **stops and changes
nothing**: the version the last good check found is kept, and no channel can be
switched until a document reads again. A read that goes wrong is never allowed
to look like "general access is at version zero" — and **absence only counts as
a first start if this installation has never read a manifest**, which is
remembered across restarts.

### Switching

Switching rewrites the image line for both services — the control plane's and
the updater's, which are published together and may never be on different
channels — and **then performs the upgrade**, as one run. It has to be one act:
the channel is read back from the container that is running, so writing the
file alone would leave the installation reporting general access while its file
said `beta`, which is a switch that appears not to have worked. The change is
shown as a deployment-file diff before it is applied, like every other change
to that file, and the previous copy is kept as `firetower.yml.backup`. If the
new control plane does not answer, the file and the image go back together.

**The version beta moves you onto cannot be walked back.** Beta installs every
release as it is cut, and the migrations of versions general access has not
reached yet run on your database. Migrations do not run backwards, so until
general access reaches the version you end up on, the only way back is
restoring a dump and losing what has happened since. Take a backup first —
**Back up now** is on the same screen.

What this is *not* is a permanent membership. Once general access catches up to
the build an installation is holding, leaving beta costs nothing: the database
is already on that schema, and the switch is offered again by itself. What is
refused in the meantime is the downgrade, and it is refused with the two
versions named — the same never-move-backwards rule everything else here
follows, rather than a separate rule about channels.

Four situations the screen names rather than guesses at:

* **No updater.** It cannot be asked and cannot be changed from here. General
  access is the assumption, and the row says what to do about it — the same
  treatment an upgrade already gets.
* **An unrecognised tag.** `latest`, `edge`, a `major.minor` tag or a local
  build name no channel. They resolve to general access, which is the safe
  answer, and the screen says the tag was not recognised rather than asserting
  a channel.
* **An exact version in the image line.** The updater will not move a container
  pinned to one build at all, so there is nothing to switch until that line is
  changed.
* **A hand-edited image line** has changed channel, with no confirmation and no
  record. That is the consequence of choosing truth over intent: what you are
  running is what you are running.

Machines are not moved by a switch. A worker is brought level with the control
plane afterwards, from the control this screen already has, so the switch
stays one decision rather than two bundled into one press.

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

## Which release you are offered

Which version the screen offers depends on the **channel** the installation is
on, which is the tag on the image it is running: `:stable` is general access and
`:beta` is every release as it is cut. Nothing stores it.

An installation pinned to `:latest` is on no channel at all and cannot be
upgraded from this screen until its image line is changed — the updater refuses
an image whose stamped version is not the one it was told to fetch, and says so
naming the tag to use. [docs/channels.md](channels.md) has all four tags, which
one to pin, and why `latest` is not it.

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

An install that predates the updater has no such container yet, and one whose
`.env` has no `FIRETOWER_UPDATER_TOKEN` has one that refuses everything. Either
way the control plane is the only target affected: workers are moved over ssh
and no deployment file is written for them, so the screen still upgrades them
and says, against the control plane's own row, what to do about it — one
`firetower upgrade` on the machine to add the updater, or the one line to add
to `.env`.

## Where things are kept

Every run and every step is a row in the control plane's database, with the
commands that were run and what they said — redacted, bounded. That is what
lets the run survive the control plane being recreated in the middle of it:
the new process finds the step that was waiting, asks the updater how the job
went, and carries on with the workers.

That holds for any step, not only the one that causes the restart. Every step
can be walked into again — the preflight only looks, a backup takes another
dump, the updater step asks the updater what version it is now — so a control
plane that goes away for its own reasons during an upgrade picks up where it
was rather than losing the run. A step restarted three times is not tried a
fourth: at that point it is the control plane that cannot stay up, and the run
says so.

Every ssh key materialisation for an upgrade is a line in the vault's access
log, with the run and the machine as its reason.

## Backups

An upgrade of the control plane takes a `pg_dump` into `backups/` beside the
compose file first. It dumps `public` — the schema every migration writes to
and the only one a restore needs — and keeps the ten most recent, deleting
older ones after each new dump lands.

**Back up now**, on the Updates screen, runs the same thing without upgrading.
Worth pressing once after a deployment changes: until it existed, the only way
to find out a backup was broken was to try to upgrade.

### When the backup fails

The run stops and asks. Nothing has been upgraded at that point, and the screen
offers **Upgrade without a backup** or **Cancel** — an upgrade with no way back
is a decision, not something a failed step gets to make. The step stays in the
run's history as a warning, so it says later that the upgrade went ahead
without one.

### Schemas Firetower did not create

The backup counts the schemas in the database first and says so when there are
any that are not `public`. Everything Firetower has is in `public`, so the
usual cause is something else sharing the Postgres instance — which is fine,
and which the backup skips.

They are harmless to the control plane. What they do affect is `pg_dump`: it
locks everything it dumps in one statement, so a database with enough of them
in it could not be dumped at all before the backup was narrowed to `public`.

To clear schemas that should not be there, with the compose project's database
container — the pattern below matches the ones a Firetower checkout's test
suite leaves, so change it to match yours:

```sh
docker exec -i firetower-postgres-1 psql -U firetower -d firetower <<'SQL'
SELECT format('DROP SCHEMA %I CASCADE;', schema_name)
FROM information_schema.schemata
WHERE schema_name LIKE 'test\_%'
\gexec
SQL
```

`\gexec` runs each `DROP` as its own statement. Do not wrap them in one
transaction — a thousand drops together exhaust `max_locks_per_transaction`
and fail having done nothing.

## Environment

| Variable | Where | Meaning |
| --- | --- | --- |
| `FIRETOWER_UPDATER_TOKEN` | `.env`, read by both services | The shared token. |
| `FIRETOWER_UPDATER_URL` | control plane | Where the updater is; `firetower.yml` sets it. Unset means no updater. |
| `FIRETOWER_NOTIFY_URL` | control plane | Also receives one POST per new release, if set. |
| `FIRETOWER_UPDATE_FEED` | control plane | The releases list to read, GitHub's by default. The newest published `firetower-v*` release in it is the one; the desktop app's tags in the same list are skipped. |
| `FIRETOWER_UPDATE_RAW` | control plane | Where release files are fetched from, for the diffs. |
| `FIRETOWER_CHANNEL_MANIFEST` | control plane | The channel manifest, GitHub's by default. Overridable for a test or a mirror; no installation needs to set it, because the channel is derived rather than configured. |
| `FIRETOWER_UPDATER_HELPER_IMAGE` | updater | The image Compose is run from. `docker:28-cli` by default. |
