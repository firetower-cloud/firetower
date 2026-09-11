# Run agents directly on a host

A workspace chooses a machine and an execution environment. Both the machine
hosting Firetower and remote machines support **Container** and **Directly on
host**. Each configured environment is a separate worker connection. A workspace
keeps that connection for additional agents, restarts and resumes.

When the control plane runs in Docker, the built-in local environment is shown
as **Firetower container**. It shares the control plane's container; its
`localhost` is not the underlying VM. When the control plane runs natively, that
environment is shown as **Firetower host process**.

## Connect an environment

Open Compute → Add compute, or **Set up an execution environment** in the new
workspace form:

1. Select **This server — alongside Firetower** or **A remote machine**.
2. Choose **Container** or **Directly on host**.
3. Supply a name, an SSH address reachable from the control plane, and an SSH
   account. Authorize Firetower's public SSH key on that account, or select a
   private key already available to the control plane.
4. For container execution, name an existing worker container. For native
   execution, the worker binary must be available directly on the SSH account's
   PATH.
5. Choose **Check and add**. Read the missing requirements, install or repair
   them on the machine yourself, and choose **Check again**.

For the underlying VM on the same server, use its reachable IP or hostname.
Entering `localhost` while the control plane is in Docker connects inside that
container. The same-server option groups the connection with the built-in local
environment; it does not change routing or discover the VM's address.

Remote environments sharing an SSH hostname and port are grouped as one
machine. Use the same address spelling when adding its second environment.
Accounts and container names may differ. Connections through different SSH
ports are shown separately.

Firetower checks requirements and reports the actual account running the
worker. It does not install requirements, configure sudo, switch accounts, or
start a container through this setup flow. Native workers and their agents use
the configured SSH account's permissions. For container execution, the worker
uses the container's configured account, which can differ from the SSH account.

The agent's existing permission controls still apply within that environment.
For example, Codex's **Everything** filesystem setting permits writes outside
the workspace using the worker account's access. Selecting native execution
does not automatically change those agent controls.

## Prepare a native worker

The worker needs Git, tmux, a POSIX shell, a writable state directory, and the
selected agent executable. Working system certificates are needed for HTTPS.
For example, on Debian/Ubuntu, the operator can install system tools with:

```sh
sudo apt install git tmux ca-certificates
```

Install a `firetower-worker` binary built from the same Firetower version or
commit as the control plane, for the target machine's operating system and
architecture. From a matching source checkout on a machine with Rust installed:

```sh
cargo build --release -p ft-cli --no-default-features --bin firetower-worker
sudo install -m 755 target/release/firetower-worker /usr/local/bin/firetower-worker
```

The binary can also be built on a compatible build machine and copied to the
worker. Running an already built binary does not require Rust. This repository
does not currently publish standalone worker release binaries; the container
installer (`firetower worker install`) is not a native-worker installer.

Install your agent using its installation instructions. Firetower also has
commands for installing agents into its own state directory if Node.js/npm are
available. Run these as the SSH account:

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

Choose the machine and **Run in** option in **New workspace**. If several
connections provide that mode, select the environment by name. An unconfigured,
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

Update the native worker binary yourself when updating Firetower. This feature
uses worker protocol 14; older workers report a protocol mismatch until updated.
Existing host and workspace records retain their execution targets during the
upgrade. No existing worker is automatically converted between native and
container execution.
