# Kimi Code through ACP (experimental)

Firetower can drive a preinstalled Kimi Code CLI through `kimi acp`. This is
an additional transport; Claude Code retains stream-json and Codex retains
its app-server. The initial integration accepts text prompts only.

## Connect Kimi Code

1. Use a Firetower server, worker and client built from this ACP-enabled branch.
   A server update alone is not enough; see the compatibility note below.
2. Install Kimi Code CLI on the **worker machine that will run the agent**.
   For a remote worker, run the following steps there, not on your laptop.
3. As the **same operating-system user that runs the Firetower worker**, check
   that Kimi is available and sign in:

   ```sh
   command -v kimi
   kimi --version
   kimi login
   ```

   Complete the authentication flow opened by `kimi login`. The tested CLI
   version is Kimi Code 2.0.2. The worker process must have `kimi` on its own
   `PATH`, including when it is started by a service manager. In a container,
   install and authenticate Kimi inside the worker's runtime environment.
4. In Firetower, create a workspace or add an agent to an existing workspace,
   select that worker, then choose **Kimi Code**.
5. Once Kimi starts, use the existing **Model** and **Thinking** pickers under
   the message field. Their choices come from Kimi and can vary by model.
6. Send a short message and check that a reply appears and the turn finishes.
   Detecting the executable or displaying a model list alone does not verify
   that the worker's login and quota permit a conversation.

There is no separate **Connect Kimi account** flow or API-key field in Firetower
in this version. It uses the worker user's existing Kimi login. The **no account**
label refers to Firetower-managed accounts; it does not mean that Kimi is signed
out. Preserve that user's Kimi configuration and session storage across worker
restarts. A laptop login does not authenticate a remote worker.

If Kimi is missing, check the worker process's `PATH`. If startup reports an
authentication failure, run `kimi login` as that worker user and start the agent
again. If the model selectors are missing, check that both the worker and the
client include this integration and that the Kimi session has started.

This prototype uses that worker login. It does not isolate Kimi accounts per
Firetower user, transfer credentials, install Kimi, or participate in account
and quota fallback. People allowed to start sessions must also be authorized
to use the worker's Kimi account. Authentication is reported as unknown until
a session runs; detecting an installed binary does not verify authentication.
An installed binary allows attempting a session; it is not proof of authenticated
readiness. Login failures are surfaced by the session startup.

Select **Kimi Code** when creating a workspace or adding an agent. No account
needs to be connected in Firetower. Model and thinking selectors use Kimi's
advertised ACP session configuration; permission mode comes from Kimi's
configuration. Requests Kimi sends appear in Firetower's existing approval UI;
Firetower does not override the agent's existing permission rules. Images,
permission-mode controls, automatic PR descriptions and automatic installation
are not supported yet.

Kimi 2.0.2 negotiated ACP v1 and `loadSession` in the live compatibility check.
It runs with its own filesystem/terminal tools. This client advertises neither
optional host capability and explicitly rejects unsupported reverse requests.

## Model and thinking controls

The existing Firetower pickers expose only the model and thought-level options
announced by Kimi in `configOptions`. Lists, labels, current values and RPC IDs
come from the agent; Firetower does not maintain a model catalogue. Changes use
`session/set_config_option`, and return success only after Kimi replies with its
configuration. A refusal leaves the last accepted value visible. A timeout is
reported as unconfirmed, since the agent may still complete the change. A second
change is rejected while the first is awaiting a reply, including across clients.

Full configuration responses and `config_option_update` notifications replace
the previous options, including any model-dependent thinking levels. On restart,
Firetower reads the configuration returned by `session/load` rather than applying
cached defaults. Kimi owns persistence of its settings. Model selection was
verified on Kimi Code 2.0.2; older Python `kimi-cli` versions can have different
configuration and persistence behavior.

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
is 16 because older workers cannot deserialize the new agent variant or its
configuration command.
The released desktop client also rejects ACP conversation frames under its old
schema, leaving a session apparently working after the agent has replied. For
this prototype, build the desktop client from the same branch; installing the
server alone is not enough.
