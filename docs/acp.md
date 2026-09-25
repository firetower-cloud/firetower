# Kimi Code through ACP (experimental)

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

Upgrade workers and clients with the control plane: the worker protocol version
is 17 because older workers cannot deserialize the new agent variant, its
configuration command, or a sign-in that names which agent it is for.
The released desktop client also rejects ACP conversation frames under its old
schema, leaving a session apparently working after the agent has replied. For
this prototype, build the desktop client from the same branch; installing the
server alone is not enough.
