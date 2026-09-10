# Agent accounts and quota recovery

Connect multiple named Claude Code and Codex accounts from **Agents → Connect
account**. Claude Code uses its existing setup-token flow; Codex uses device
sign-in. A connection's name is a Firetower label. Account identity is shown only
when the authentication response supplies one.

Choose a default for new tasks, or select an account when creating a workspace.
Existing runs stay pinned to their account. Rename, reconnect, change the default,
or disable a connection from the agent's account list. Disabling prevents new
selections; it does not interrupt runs already using the account.

In a conversation, **Switch account** continues in the existing workspace.
Stop a running turn and resolve pending approvals first. Switching within the same
agent resumes the native conversation. Codex uses `thread/resume`; a rejected
resume is surfaced as a failure rather than silently starting a new thread.
Switching agents creates a new conversation tab with the original request and
recorded progress. Files, checkouts and branches remain in place. The destination
must inspect current changes and test results; internal reasoning is not copied.
Cross-agent handoffs require accepting the destination's default permissions.

**On usage limit → Edit** enables an ordered fallback list for this task. It is
off by default. Only explicitly selected connections can be used. Including a
connection authorizes its quota consumption, destination default permissions for
a different agent, and metered charges if it is an API-key connection. The
server performs recovery even when no browser is open. Each target is attempted
at most once per saved order; a switching error disables automatic recovery.

## Limits

Claude Code's structured `rate_limit_event` and Codex's
`account/rateLimits/updated` events are recorded per connection and per window.
Explicit rejection/exhaustion errors can trigger recovery. A percentage reaching
100% is displayed but does not automatically interrupt a running agent. Generic
429s, authentication failures, network failures and arbitrary assistant text do
not trigger account switching. A missing remaining balance is displayed as
unknown, and elapsed reset timestamps only make an account eligible to retry.

An idle connection's quota may be stale, especially if it is used outside
Firetower. There is no estimated balance based on token counts.

## Upgrade

The additive migration creates a default named connection for each existing
agent configuration and pins existing sessions to it. It retains the original
vault key names and ciphertext, including host-local authentication with no
portable credential. No reauthentication is required by the migration.

Worker protocol 13 is required for acknowledged launches and isolated Codex
homes. Deploy the updated control plane and workers together. Each run gets its
own mutable authentication directory. Existing workspace-level Codex history is
copied on first use; the old directory is preserved for running legacy sessions.

## Verification

Database tests exercise the previous schema with existing encrypted credentials,
owner isolation, pinned defaults, duplicate credentials, and independent quota
windows. Worker tests check separate credentials and preserved legacy history.
Quota classification tests reject ambiguous errors. Provider sign-in and native
resume across real subscriptions still require valid provider accounts to test;
synthetic quota fixtures cannot establish provider entitlement or availability.
