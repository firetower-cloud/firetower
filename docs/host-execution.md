# Run agents directly on a host

A workspace chooses a **machine** and a way of running on it: in a worker
**container**, or **directly on the host**. A machine is a place; the two ways
of running are modes, and both are offered on every machine Firetower reaches
over SSH. Each mode is a separate worker connection underneath. A workspace
keeps the connection it started on for additional agents, restarts and resumes.

**"This server — alongside Firetower" is the process the control plane already
is.** It has one mode and states it rather than offering a choice: the Firetower
container when the control plane runs in Docker, the machine itself when it runs
natively. The other environment on that same box — the host under a
containerised Firetower, or a worker container beside a native one — is reached
over the network like anything else, so it is added as a machine and chosen like
any other.

## Add a machine

Open Compute → **Add a machine**, or pick **+ Add a machine…** at the end of the
machine list in the new workspace form. It asks for two things:

1. **An SSH address** reachable from the control plane, in the form ssh takes:
   `editor@192.0.2.10`, with `:2222` for a port that is not 22. Left off, the
   account is whatever your SSH config says.
2. **A name**, optionally. Left blank, the machine is called where it is.

Authorize Firetower's public SSH key on that account, or select a private key
already available to the control plane. Choose **Add**; a machine that does not
answer is still saved, with what it said and what to do about it.

Both ways of running are then available on it. Firetower checks whichever you
pick, when you pick it, and the environment behind it is created then — there is
nothing to set up in advance and no separate setup step.

For the underlying VM on the same server, use its reachable IP or hostname.
Entering `localhost` while the control plane is in Docker connects inside that
container.

Environments sharing an SSH hostname and port are one machine. Use the same
address spelling for both. Accounts and container names may differ. Connections
through different SSH ports are shown as separate machines.

Firetower checks requirements and reports the actual account running the worker.
It installs two things when asked — its own worker binary, and an agent — and
nothing else: it does not install system packages, configure sudo, switch
accounts, or start a container. Native workers and their agents use
the configured SSH account's permissions. For container execution, the worker
uses the container's configured account, which can differ from the SSH account.

The agent's existing permission controls still apply within that environment.
For example, Codex's **Everything** filesystem setting permits writes outside
the workspace using the worker account's access. Selecting native execution
does not automatically change those agent controls.

## Prepare a native worker

**Firetower installs the worker itself.** Readiness is measured *by* a worker, so
a machine without one reports a single missing requirement — the worker
connection — and offers **Install the worker** beside it. That copies the binary
this control plane is running, at the version it is running, down the SSH
connection it already has, into `~/.firetower/worker/bin`. No sudo, nothing
outside the account's home, and nothing touched that you installed yourself: the
remote command puts that directory *last* on `PATH`, so a `firetower-worker` you
put on the machine is still the one that answers.

This works when the machine is the same operating system and architecture as the
control plane, which it checks with `uname -sm` before sending anything. When
they differ, install a `firetower-worker` built for that machine into
`~/.firetower/worker/bin` or onto the SSH account's `PATH` yourself. From a
matching source checkout on a machine with Rust installed:

```sh
cargo build --release -p ft-cli --no-default-features --bin firetower-worker
sudo install -m 755 target/release/firetower-worker /usr/local/bin/firetower-worker
```

The binary can also be built on a compatible build machine and copied over.
Running an already built binary does not require Rust. This repository does not
currently publish standalone worker release binaries; the container installer
(`firetower worker install`) is not a native-worker installer.

The worker also needs Git, tmux, a POSIX shell, a writable state directory and
the selected agent. Working system certificates are needed for HTTPS. Those come
from the machine's own package manager, which is yours to run — Firetower shows
the command and does not run it:

```sh
sudo apt install git tmux ca-certificates
```

The agent it fetches itself: the readiness panel offers **Install** beside a
missing agent, which is the same thing the Agents screen does. By hand, as the
SSH account:

```sh
firetower-worker agents add claude-code
# Or:
firetower-worker agents add codex
```

The native worker uses `~/.firetower/worker` for state by default. It is launched
on demand over SSH; there is no additional daemon or PostgreSQL service to
install. Docker is optional. Existing agent executables on PATH take precedence
over copies installed under the worker's state directory. Node/npm are reported
as optional because an existing, working agent may not require them.

Verify tools from a non-interactive SSH command, using the same account and
address configured in Firetower:

```sh
ssh editor@video-vm 'command -v firetower-worker git tmux sh; firetower-worker --version'
```

A tool available only after manually activating a shell environment may need
its PATH or a wrapper configured for the worker. The readiness check runs with
the PATH Firetower supplies to agents, including its managed agent directories.

## Launch and resume

Choose the machine and the **Run in** mode in **New workspace**. If a machine
has two environments of the same mode, a **Which one** row appears; it does not
otherwise. An unconfigured,
drained, unavailable or unready environment cannot silently fall back to a
different worker. Required checks must pass before launch; the server checks
again when starting or restarting an agent.

Checks cover the worker connection, Git, tmux, shell, state-directory write
access and the selected agent's ability to execute `--version`. They do not
validate application credentials, network routes, graphical sessions, GPU
configuration or every command an agent may later run. Configure those on the
machine as needed. A native worker can use host filesystem repository paths;
those paths must exist on the selected host.
Filesystem repository paths can be connected before choosing a machine. Their
default branch is read by the selected worker at launch, rather than by the
control plane when the repository is added.

Changing machine or execution mode requires a new workspace. Ending a
workspace cleans up its Firetower worktrees, sessions and labelled Docker
resources; it does not uninstall host tools or remove application directories.
Removing a native SSH connection does not uninstall its worker. Provisioned
containers connected through SSH remain owned by the operator.

## Upgrades

Update the native worker when updating Firetower: **Install the worker** again
sends the version the control plane is now running. This feature uses worker
protocol 14; older workers report a protocol mismatch until updated.
Existing host and workspace records retain their execution targets during the
upgrade. No existing worker is automatically converted between native and
container execution.
