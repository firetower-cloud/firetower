# Machines

A worker runs on the machine itself. There is no container in between: the
agent runs as the account Firetower connects as, with that machine's tools, its
filesystem and its network. The unit of isolation is the machine — give a
worker a VM of its own if you want one, and use the machine itself when that is
the point, as it is for a Mac that has Xcode on it.

## Add a machine

Open Compute → **Add a machine**. It shows Firetower's public key. Give it to the
machine the way that machine takes keys: `~/.ssh/authorized_keys` of the account
agents should run as, on a machine you own; the provider's console, instance
metadata or OS Login on Google Cloud; the CA where there is one. That is the one
thing a machine can only get from a person.

Then the address and the account, and **Add**. Firetower connects and the
machine's panel says two things, told apart: whether ssh got in, and whether
there is a worker. A machine the key got into shows **No worker** — not
*Unreachable* — with **Install the worker** beside it. That runs the installer
over the connection it just made: the release built for that machine's shape,
into `~/.firetower/worker/bin`. No sudo, nothing outside the account's home.

What the machine is still missing is then measured by the worker and shown with
the command that installs it — `brew install tmux`, `sudo apt-get install -y
tmux` — for you to run. Firetower never runs sudo on a machine; that is the
one step it leaves to the person who has the password. Run it, **check again**.

### By hand

The installer is `install/worker.sh`, and the panel folds the by-hand line
under the button for whoever would rather watch it happen:

```sh
curl -fsSL https://usefiretower.com/worker.sh | sh
```

Run as the account agents should run as. The script:

1. Works out what the machine is — macOS or Linux, arm64 or x86_64 — and
   refuses anything else with a sentence. Windows runs it inside WSL2.
2. Checks for `git`, `tmux`, `curl` and `tar`. For each one missing it prints
   the package manager's own command and asks before running it. Pass `--yes`
   on a machine nobody is watching, or `--skip-packages` to leave them to you —
   which is how the control plane runs it.
3. Downloads the `firetower-worker` release built for that machine, checks it
   against the release's `SHA256SUMS`, and puts it in
   `~/.firetower/worker/bin`.
4. With `--authorize KEY`, appends Firetower's public key to
   `~/.ssh/authorized_keys`.
5. Says whether an sshd is running, and how to turn one on if not. It never
   turns one on itself.
6. Prints what `firetower-worker doctor` sees: the same checks Firetower runs
   over ssh, with the same PATH.

Options: `--version X.Y.Z` installs that release rather than the newest;
`--agent claude-code` or `--agent codex` fetches the agent too; `--from FILE`
installs a tarball you already have.

## What a machine needs

`git`, `tmux`, a POSIX shell, `curl`, `tar`, and an sshd. On a Mac, `git`
comes with the Xcode command line tools and `tmux` from Homebrew; on Debian and
Ubuntu, one `apt-get`. Nothing else — not Node, not Docker.

Agents are not on the list because the worker fetches them itself, as the
standalone binaries their publishers ship, into `~/.firetower/worker/agents`.
The readiness panel offers **Install** beside a missing agent; by hand, as the
ssh account:

```sh
firetower-worker agents add claude-code
firetower-worker agents add codex
```

A `claude` or `codex` already on the machine is used in preference to the copy
Firetower fetched: Firetower's directories go last on PATH.

### PATH

An ssh command gets the daemon's own PATH — `/usr/bin:/bin:/usr/sbin:/sbin` on
macOS — with nothing the account installed on it. The worker does not use that
PATH. On start it asks the account's login shell what PATH it has, adds the
places package managers put tools (`/opt/homebrew/bin`, `/usr/local/bin`,
`~/.local/bin`, `~/.cargo/bin`), and runs every check, tmux session and agent
with the result. A tool installed after the worker is found the next time the
worker connects, with nothing to configure.

To see exactly what a machine has as Firetower sees it, on the machine:

```sh
~/.firetower/worker/bin/firetower-worker doctor --agent claude-code
```

## What the worker does and does not do

It runs agents under tmux, so they outlive the connection; keeps repository
mirrors, worktrees and its event log under `~/.firetower/worker`; and reaches
a port a session is serving through the connection Firetower already holds,
so nothing is published. Sessions can run Docker if the machine has it — it is
the machine's daemon and the machine's port space.

It does not install system packages, configure sudo, switch accounts or open a
port. Ending a workspace removes its worktree and tmux session; it does not
undo what an agent installed on the machine. Removing a machine from Firetower
forgets it and touches nothing on it.

Workspace resource limits use cgroups and apply on Linux when the account can
write `/sys/fs/cgroup`; a machine where it cannot says so and runs the session
without them. macOS has no equivalent.

## Upgrades

The Updates screen reinstalls a worker the same way it was installed: the
script, over ssh, pinned to the control plane's version, one machine at a time,
drained first. By hand, running the one line again does the same; the newest
release is what it fetches unless `--version` says otherwise.

## The machine running Firetower

**This server — alongside Firetower** is the control plane's own process, and
needs `git`, `tmux` and a shell on that machine. A control plane running in
Docker does not run agents in its own container: add the machine underneath it
over ssh, like any other.
