# Adding an agent

What it takes to make Firetower drive another coding agent, and what to check
before believing it works. Written after adding Kimi Code, and every trap named
here is one that was actually hit.

Read it in order. The questions early on decide whether the rest is possible.

## Before anything: two questions that decide feasibility

Answer these against the real CLI, not its documentation. The documentation
described an older release than the one we installed, and the difference was
the whole feature.

- **Can its home be relocated by an environment variable?** Codex has
  `CODEX_HOME`, Kimi has `KIMI_CODE_HOME`. Without one there is no per-session
  isolation, no two accounts on one worker, and no credential that can travel.
  Everything below assumes this.
- **Can it log in headlessly?** Something that prints a code, polls, and exits.
  If the only way in is an interactive terminal UI, the control plane cannot
  sign anybody in and you should stop here and say so.

## Declare it

- Add the variant to `Agent` in `ft-core/src/lib.rs`, then to `all()` — what is
  offered when starting work — and `every()`, which is what lets an old session
  row still decode.
- Answer every capability method: `label`, `command`, `installable`,
  `needs_credential`, `speaks_a_protocol`, `signs_in_with_a_code`,
  `credential_file` or `credential_bundle`, `home_var`, `api_key_var`,
  `token_setup`, `auth_status_command`, `first_run`, `hooks`, `hooks_file`,
  `opening`, `launch_headless`.
- **Watch the `matches!` ones.** `needs_credential`, `signs_in_with_a_code` and
  `credential_bundle` are written as `matches!(self, ...)` rather than an
  exhaustive `match`, so a new variant compiles and quietly gets the wrong
  answer. The compiler will not help. Grep for them.
- The agents list the clients read is built from `Agent::all()` in
  `ft-server/src/api/agents.rs`. If a new agent does not appear in a client,
  check which build the *control plane* is running before looking anywhere
  else — it is almost always that.

## Install it from the control plane

A worker should be a machine that runs agents, not a machine somebody has to
remember to prepare.

- Implement the fetch in `ft-worker/src/runtime.rs` and wire it into
  `install`, which is what `ToWorker::InstallAgent` calls.
- Test it against an **empty worker root**, not your own machine. Your machine
  already has the agent, which is exactly why it will lie to you.
- Check the copy that runs is the copy that was installed: build a `PATH` with
  no global copy on it and start a session. It must land in
  `agents/<name>/<version>/bin/` and survive the staging rename.
- **Take the binary, not the package.** Every agent so far publishes an npm
  package as well as a per-platform binary, and the package is the easier one
  to reach for — `npm install --global --prefix` is four lines and works on
  your laptop. It then fails on the machines that matter: a worker started by
  launchd or sshd has the login shell's `PATH` and not the interactive one, so
  the Node somebody installed through a version manager is invisible to it and
  the install dies with `No such file or directory (os error 2)`. Kimi shipped
  this way once and this is what it did. Look for the publisher's `install.sh`
  and read what it fetches; that is the URL you want.
- Note any new host dependency, and treat needing one as a reason to look
  harder. `curl` and `tar` are the budget.
- Add the directory name in both `runtime.rs` and `worker_main.rs` —
  `agents add <name>` resolves through it.

## Sign it in from the control plane

- The login runs **on a worker**, never on the laptop. The provider hands the
  credential to whichever machine asked for the code, so that machine has to be
  one we can take it from.
- Reuse `AgentLoginStart` and its answers, dispatching on the agent. Two agents
  already share them; a third set of near-identical messages is how a protocol
  becomes unreadable.
- Bound the wait for the *code* separately from the wait for *approval*.
  Getting a code is seconds and a failure is worth reporting; approval is a
  person and can take a quarter of an hour.
- **Check which stream the code comes out on**, by running the real login and
  looking — not by reasoning about it. Kimi puts the code, the URL and its
  final verdict on *stderr* and leaves stdout empty, because stdout is
  reserved for the ACP stream. Reading the wrong one is invisible to any test
  that feeds strings to the parser: parsing is fine, the pipe is empty, and
  every sign-in fails by timing out. Keep an `#[ignore]`d test that starts a
  real login and asserts a code came back.
- An abandoned sign-in must die — `kill_on_drop` and a hard expiry. Nothing
  should still be polling a provider after the dialog was closed.
- Ask whether accounts are regional. Kimi's `global` and `mainland-cn` are
  separate namespaces rather than mirrors, so the wrong one signs a different
  person in and reports success. If there are regions, carry them on `SignIn`
  and let somebody choose.

## Keep the credential, and travel it

- Delete the login's home once the credential is out of it. Leaving a copy on
  the host is the thing this design exists to avoid.
- Find out whether it is one file or several. Codex round-trips one
  `auth.json`. Kimi splits the same thing between `config.toml` and
  `credentials/<hash>.json`, where the hash is not a name anything can predict
  — so it travels as a bundle of path to contents. That is what
  `credential_bundle` is for.
- **Prove the round trip.** Collect the credential out of one home, write it
  into a new empty one, and start a session from that with no login ever
  performed against it. If that works, the vault model works; if it does not,
  nothing else matters.
- `write_agent_home` writes `0600` files into a `0700` directory, allows nested
  relative paths, and refuses anything absolute or climbing out.

## The transport

- Give `normalise::Reader` a variant and the worker a module. Journal both
  directions so a reconnect reads the log rather than asking the agent to say
  it all again.
- The session's `PATH` is set once when the session starts and inherited
  through tmux, which is why launchers pass `env: vec![]`. Anything spawned
  outside that chain has to apply `runtime::with_agents` itself.
- The worker's input loop ends on stdin EOF. That is right under agentd and it
  will confuse every manual test you write, because a one-shot pipe closes.

## Controls

- Enumerate what the agent actually advertises, not what you expected. Kimi
  offers a permission mode alongside the model and thought level, and the first
  implementation dropped it with a `_ => return None` — hiding a picker that
  worked.
- A change is confirmed by the agent, never assumed. A refusal leaves the last
  accepted value showing.
- If a change in flight blocks the next one, make sure the block can clear. An
  agent that never answers must not lock the pickers for the life of the
  connection.

## Every client

Desktop, web and mobile do not share components. Each needs the agent.

- The mark and the labels: `AgentMark.tsx` in all three, plus `AGENT_LABEL` and
  `AGENT_SHORT` on desktop and web.
- Check the picker on **each**, mobile included — its picker reads `supported`
  and ignores per-host `installed`, so it will offer an agent that is not there.
- Grep for agent names rendered raw. `agent === "ClaudeCode" ? "Claude Code" :
  agent` prints the variant verbatim for everything else.

**Do not special-case an agent in a client.** This is the mistake worth
learning from. Kimi first shipped reporting `needs_credential` while the
backend had nowhere to keep a credential, and six `kind === "KimiCode"` checks
were scattered across the clients to hide the contradiction. The seventh was
missed, and the account switcher went on offering to connect an account the
server would refuse. A per-client exception is a sign the model is wrong. Fix
the concept.

## Contract and protocol

- Regenerate: `cargo run -p ft-server --bin gen-openapi`, then `orval` in all
  three clients. CI fails on a stale contract.
- Bump `PROTOCOL_VERSION` for any change to a worker message, and write down
  why on the line above it.
- A bump means server, workers **and** clients go out together. It is not a
  rolling update, and a released client may refuse the new frames while looking
  like it is working.

## Verify it live

Fixtures prove the shape. They do not prove the agent. Run all of these against
the real thing with a real account:

- A turn completes and text streams back
- A follow-up remembers the turn before it
- Model, effort and mode change mid-session
- A tool call **approved** — and the side effect really happened
- A tool call **denied** — and the side effect really did not
- Cancellation reports interrupted rather than failed
- Restart and reconnect resumes without replaying history into the transcript
- An unentitled or expired account gives a readable error rather than a hang

## Things that will take a day from you

- A dev server left running on a port, serving a worktree that was deleted
  weeks ago. Check what is answering before debugging what is asking.
- Sandboxed egress blocking the provider's auth host. A device login needs real
  network, and the failure looks like the provider being slow.
- A background process that outlives the shell which had the network.
- The provider's documentation describing an older CLI than the one you just
  installed.
