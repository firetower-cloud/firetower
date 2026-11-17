# ACP agents

## Connect Cursor Agent

Cursor Agent uses the official `cursor-agent acp` CLI and ACP protocol v1. The
host installs the complete vendor archive, including its bundled Node runtime
and native modules. Firetower pins build `2026.09.28-64d2043` and verifies the
archive digest before unpacking it. Verified archives cover macOS arm64/x64
and glibc Linux arm64/x64. Musl Linux and other platforms are refused at
install time.

1. Update the server, workers and clients together; the worker protocol is 21.
2. In **Configuration → Agents → Cursor Agent**, install the CLI on a host.
3. Connect a **Cursor Agent** subscription account. Firetower starts
   `cursor-agent login` with a private file-backed credential store and shows
   its browser link. Open the link and complete Cursor sign-in. Cursor's flow
   has no device code to type.
4. Wait until the account says **connected**, then select it for a new Cursor
   Agent workspace. Firetower puts only `.cursor/auth.json` into the account
   vault and writes it into a private home for each session. No worker needs a
   manual Cursor login. API-key mode is not exposed.

This uses the signed-in Cursor account's agent usage and plan limits. If that
account has on-demand usage enabled, charges beyond included usage may apply;
check the [Cursor usage and billing documentation](https://prod.cursor.com/help/account-and-billing/overages)
and the account dashboard before running long unattended sessions. Firetower
does not turn a subscription login into an unlimited allowance or impose a
separate Cursor spending cap.

The file credential store is selected with
`AGENT_CLI_CREDENTIAL_STORE=file`; `HOME`, `CURSOR_CONFIG_DIR`,
`CURSOR_DATA_DIR` and `XDG_CONFIG_HOME` are private to the login or session.
The private `cursor` directory alias makes Linux's XDG credential path and
macOS's `.cursor/auth.json` refer to the same file. Cursor's default macOS
Keychain store is unsuitable for moving an account to a different worker. A
credential copied from a Mac home authenticated a Linux arm64 container. A
fresh Firetower worker root installed the pinned CLI without a global copy on
`PATH`; its ACP wrapper completed a harmless turn, then restarted with
`session/load` and one explicit follow-up that remembered the first answer.
A separate remote worker host and each production client still need live
acceptance.
Sessions read the restored file during `session/new`. Firetower does not call
ACP `authenticate(cursor_login)` while starting a workspace, because that RPC
can open a fresh browser login when the file is missing; the account connection
flow is the only place that creates a login link.

Cursor can send extension requests such as `cursor/ask_question` and
`cursor/create_plan`. Firetower currently returns an unsupported-method error
for extension requests it cannot serve; it never leaves them unanswered. ACP
permission requests are routed through the normal Firetower approval path.

In a live read-only delegation probe, Cursor emitted a `Task:` tool call and a
matching `cursor/task` notification with a subagent ID and duration after the
call ended. Firetower maps that pair to a subagent card and completion status.
The observed parent ACP stream carried the Task call and its result, but no
separate child tool calls or child progress. Firetower cannot show the child's
own tool activity from that stream; this remains an acceptance gap until the
provider emits it or a supported API exposes it.

## Kimi Code

Firetower drives the Kimi Code CLI through `kimi acp`. This is an additional
transport; Claude Code retains stream-json and Codex retains its app-server.
It accepts text prompts only — images are not carried yet.

## Connect a Kimi account

The same shape as Codex, and for the same reasons. Firetower installs the CLI,
runs the device login on a host, and keeps the credential in its own vault — so
a worker is a machine that runs agents rather than a machine somebody has to
remember to log into.

1. Use a server, worker and client built from this branch. A server update
   alone is not enough; see the compatibility note below.
2. **Configuration → Agents → Kimi Code → Install** puts the CLI on a host.
   Like every other agent it is a single downloaded binary — the one Kimi's own
   `install.sh` fetches, checked against the checksum in its published
   manifest. The host needs `curl` and `tar` and nothing else. **Not Node.**
3. **Connect a Kimi Code account.** Firetower runs `kimi acp --login` on a host
   and shows the device code. Approve it in a browser, wherever you are.
4. Create a workspace, choose **Kimi Code**, and choose that account — the same
   picker every other agent uses.

Each session gets its own `KIMI_CODE_HOME`, written from the vault at start and
belonging to nobody else. Several accounts can run on one worker at once, and
no `kimi login` is ever run by hand on a worker.

Accounts are per region. `global` is kimi.ai and `mainland-cn` is kimi.com;
they are separate namespaces rather than mirrors, so the wrong one signs a
different person in and reports success. Sign-in defaults to `global`.

What travels is a *bundle*, not a file — Kimi splits its credential between
`config.toml` and `credentials/<hash>.json`, and the hash is not a name
anything can predict. Both are stored together and written back out exactly as
they were found. See [`Agent::credential_bundle`].

Kimi ships glibc builds only, so **Install** refuses on musl (Alpine) rather
than leaving a binary that cannot start.

If a sign-in fails, check that `kimi` is on the worker process's `PATH`,
including when a service manager starts it — **Install** puts it there, but a
copy installed by hand into a shell-only directory is not seen by a worker
launchd or sshd started.

Kimi 2.1.1 negotiated ACP v1 and `loadSession` in the live compatibility check.
It runs with its own filesystem/terminal tools. This client advertises neither
optional host capability and explicitly rejects unsupported reverse requests.

## Model, thinking and mode controls

The existing Firetower pickers expose the model, thought-level and permission
mode options announced by Kimi in `configOptions`. Lists, labels, current values and RPC IDs
come from the agent; Firetower does not maintain a model catalogue. Changes use
`session/set_config_option`, and return success only after Kimi replies with its
configuration. A refusal leaves the last accepted value visible. A timeout is
reported as unconfirmed, since the agent may still complete the change. A second
change is rejected while the first is awaiting a reply, including across clients.

Full configuration responses and `config_option_update` notifications replace
the previous options, including any model-dependent thinking levels. On restart,
Firetower reads the configuration returned by `session/load` rather than applying
cached defaults. Kimi owns persistence of its settings. Model selection was
verified on Kimi Code 2.1.1; older versions can have different configuration and
persistence behavior, and 2.0.2 had no `--login` for the device flow above.

## Session behavior

The ACP connection runs beneath the existing tmux supervisor. Browser and
worker disconnections do not close the agent's stdin. Both wire directions are
journalled; the core normaliser derives conversation and lifecycle events.
Unknown updates remain raw records. This prototype does not claim full ACP
rendering fidelity.

Session IDs persist per Firetower session. On restart, the load capability is
checked first. Loaded history is not duplicated in Firetower's transcript.
Unsupported load, or Kimi's explicit missing-session response, creates a fresh
session with prior conversation carried as context alongside the next user
prompt. History is never sent as an autonomous task. Authentication errors,
quota errors, timeouts and ambiguous interrupted work are not replayed.

Permission replies preserve the agent's option IDs. A one-off approval cannot
select a persistent approval option. Unsupported decisions cancel the request.
IDs include the connection epoch so stale answers cannot authorize a new
process's reused request ID. Stop sends `session/cancel`, cancels pending
approvals, and closes the connection if cancellation is not acknowledged within
ten seconds. Ordinary prompts have no fixed completion timeout.

## Verification

The transport tests require Python 3 for a deterministic ACP subprocess. They
cover startup, follow-up prompts, load and fallback, context carry, approval,
denial, stale IDs, cancellation, malformed output and process exit. No model
or credentials are used by those fixtures.

```sh
cargo test -p ft-core --test normalise_acp --locked
cargo test -p ft-worker --test acp --locked
cargo test -p ft-worker --lib kimi --locked   # the sign-in parse and the bundle
cargo fmt --check
cargo clippy --workspace --all-targets --locked -- -D warnings
# Use a dedicated test database through DATABASE_URL.
cargo test --workspace --locked --no-fail-fast
```

Live acceptance uses a disposable Firetower workspace: text and follow-up
turns, a harmless tool action with approval and rejection, cancellation,
reconnect and agent restart. Inspect both the authenticated conversation API
and the UI. A handshake or fixture run is not a substitute for live acceptance.

Two live harnesses exist, and neither runs in CI — both need a real signed-in
Cursor account and are driven by hand:

- **Desktop**, `desktop/e2e/cursor-live.mjs`. Run it against the Vite
  renderer, server and worker from one checkout, with an isolated Firetower
  home and database. `FIRETOWER_E2E_SERVER` is the control plane's address and
  `FIRETOWER_E2E_RENDERER` the renderer's origin — `127.0.0.1:4400` and
  `http://localhost:5273` unless you say otherwise, which is where `firetower
  serve --dev` and `pnpm --dir desktop dev` put them. The renderer's port is
  flag-only: `desktop/vite.config.ts` hardcodes it with `strictPort`, so a
  second one needs `pnpm --dir desktop dev -- --port <n>` and the variable to
  match. `FIRETOWER_E2E_PASSWORD` is that server's administrator password,
  and on a fresh database that is the one the first start printed — see below.
  With no other variable it checks installation only.
  `FIRETOWER_E2E_CONNECT=1` starts the provider sign-in and prints a
  short-lived approval URL to open in a browser signed in to the intended
  account. `FIRETOWER_E2E_RUN=1` with `FIRETOWER_E2E_REPOSITORY` pointing at a
  disposable local repository containing a one-line `README.md` creates a
  workspace, sends a read-only prompt and waits for the line and an idle
  state; `FIRETOWER_E2E_FOLLOWUP=1` adds the second prompt and a page reload.
  Screenshots are written outside the checkout.
- **Mobile**, `mobile/e2e/cursor-agent.yaml` and its
  `-permissions` and `-task` companions, driven by Maestro against a
  development build with `adb reverse` onto an isolated control plane.

### A fresh backend, and the two gates it holds a sign-in behind

Use a fresh backend for a first-user run. A database nobody has signed into
yet stops a sign-in twice before the app is drawn, and the desktop script goes
through both on the way in: the first administrator's password is temporary,
so `Connect.tsx` draws **Replace this password** rather than the app, and
until an organisation is named `Gate.tsx` draws the setup wizard. Neither
screen carries anything the rest of the script looks for, which is why the
version of it that signed in and clicked straight for a destination hung
against the very database this page asks for.

So the only credential it needs is the one the server printed, once, at its
first start — on **stderr**, and nowhere afterwards:

```sh
FIRETOWER_E2E_PASSWORD=$(sed -n 's/^    password  //p' server.err) \
  node desktop/e2e/cursor-live.mjs
```

**Producing that password is still the caller's job; making it usable is
not.** The script replaces it with itself over `POST /api/v1/auth/password` —
one of the four calls a locked account may still make — which clears
`must_change_password` and leaves the caller's own credential the one that
works. It deliberately does not reach for the database to do it: `firetower
passwd admin` is the unattended route, and it defaults `DATABASE_URL` to
`localhost:5433`, which on a machine running more than one Firetower is
somebody else's administrator. Run it by hand if you want a password of your
choosing, with the server's own `DATABASE_URL` and `FIRETOWER_HOME`:

```sh
printf '%s\n' "$FIRETOWER_E2E_PASSWORD" |
  DATABASE_URL=… FIRETOWER_HOME=… cargo run -p ft-cli -- passwd admin
```

It clears the forced change in the same statement, and reads a pipe happily —
the `stty` it attempts is not fatal. `ADMIN_INITIAL_PASSWORD` (`.env.example`)
is the other way to a known password, and deliberately does *not* skip the
forced change; the script passes it either way.

### A fresh backend has no machine, and that is a prerequisite

An agent is installed **on a machine**, so with no machine the Cursor row
reads `0 of 0 machines` and has no Install control at all: the installation
check cannot pass on a database alone. That is a prerequisite rather than a
limitation of the harness — "the first thing that touches the database" and
"install an agent" cannot both be true of one run unless a machine is added
in between. The script says so in a sentence instead of waiting two minutes
for a button that cannot appear.

The cheapest machine that is not your own laptop is an **Alpine sshd
container**: `apk add openssh-server git tmux curl tar ca-certificates`, the
control plane's own public key from `GET /api/v1/ssh-key` into
`authorized_keys`, then `POST /hosts/probe`, `POST /hosts` and
`POST /hosts/{id}/worker`. It reaches `Online` in well under a minute and
touches nothing on the host. The worked sequence, and the two traps that cost
that run real time — Alpine's `adduser -D` leaves the account password-locked
and sshd then refuses it even for key auth, and rebuilding the image
regenerates host keys until `$FIRETOWER_HOME/ssh/known_hosts` is cleared —
are recorded on
[issue #332](https://github.com/firetower-cloud/firetower/issues/332).

One honest caveat about that machine. On macOS `just build-worker` can only
produce a `darwin-*` asset, so a Linux container machine never matches
`FIRETOWER_WORKER_ARTIFACTS` and **silently downloads a released worker**
instead of this checkout's build. Such a run verifies the release, not the
branch. Cross-build the Linux asset first — #332 again — if what you are
accepting is a worker change.

The Maestro flows go through neither gate: they expect a Dashboard straight
after signing in, so give them a control plane that is already past both.

## Releasing it

The worker protocol version is **20**: an older worker cannot deserialize the
new agent variant, its configuration command, or a sign-in that names which
agent it is for. It was written as 19 while this branch was open; main took 19
for travelling skills first, so Cursor follows at 20.

**A worker that is behind is refused, not broken.** The control plane compares
on `Hello` and answers a mismatch with `protocol_mismatch` — what each side
speaks, and the command to reinstall the worker. Nothing half-works, and
nobody has to guess why.

**One tag ships all of it.** `release.yml` builds the image, both desktop
platforms, mobile and the worker from a single release-please run, so a normal
release is already in step. The way to get a split is to deploy the server
image by hand without cutting one.

**An already-installed client is the part that lags**, because it upgrades on
its own schedule rather than with the server. The effect is smaller than it
was once thought: the generated zod schemas are written but never imported, so
they are not a runtime gate, and `AgentMark` falls back for an agent it does
not know. An old client shown somebody else's Cursor session degrades — an
unnamed agent, a mark it has no case for — rather than refusing frames. That
is worth confirming on a real old build before a release rather than taking
from here; it is reasoning about the clients, not a run against them.
