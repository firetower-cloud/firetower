# Agent accounts and quota recovery

Connect multiple named Claude Code and Codex accounts from **Agents → Connect
account**. Claude Code uses its existing setup-token flow; Codex uses device
sign-in. A connection's name is a Firetower label. Account identity is shown only
when the authentication response supplies one.

Choose a default for new tasks, or select an account when creating a workspace.
Existing runs stay pinned to their account. Rename, reconnect, change the default,
or disable a connection from the agent's account list. Disabling prevents new
selections; it does not interrupt runs already using the account.

In a conversation, **Switch account** continues in the existing workspace. It
does not require stopping the turn or answering a pending approval first: the
switch stops the agent as its first step, and a question that agent was waiting
on goes with the process it was addressed to — the continuation tells the
relaunched agent to ask again for anything it still needs. Only an ended
workspace refuses. Switching within the same agent resumes the native
conversation; Codex uses `thread/resume`, and a rejected resume is surfaced as a
failure rather than silently starting a new thread. Switching agents creates a
new conversation tab with the original request and recorded progress. Files,
checkouts and branches remain in place. The destination must inspect current
changes and test results; internal reasoning is not copied. Cross-agent handoffs
require accepting the destination's default permissions.

**On usage limit → Edit** enables an ordered fallback list for this task. It is
off by default. Only explicitly selected connections can be used. Including a
connection authorizes its quota consumption, destination default permissions for
a different agent, and metered charges if it is an API-key connection. The
server performs recovery even when no browser is open, and does not wait for a
running turn or an unanswered approval to clear first. Each target is attempted
at most once per saved order; a switching error disables automatic recovery.

## A lead moving a child

Recovery above is the server acting for a person who is not there. It is not
the only party that can act: a child started by a Manager died on a limit, and
the Manager is a separate session on a separate allowance that is still
running and is told what happened. It can read every subscription's remaining
allowance with `list_compute` and move the child onto one with `children`'s
`switch`, at the moment of the failure rather than from a list written in
advance.

Two profiles have to agree, and both default to today's behaviour.

**The child's profile** grants the latitude, under *If it reaches usage limit*:
*Wait for human action* (the default — nobody moves it without a person), *Let
the lead pick another subscription* (one for the engine it already runs), or
*Let the lead pick another subscription and engine*. The third is how the
acknowledgement of a destination agent's default permissions gets given: by a
person, in advance, once — a lead has read no prose and cannot give one, so
without it a cross-agent move is refused. All three are enforced by the server,
not only drawn.

**The Manager's own profile** decides whether it spends that latitude, under
*When a child runs out*: *Re-route it* picks one and carries on, *Ask me first*
stops and puts the choice to the person as a question with one option per
subscription, each carrying its limit, its reset and how old that reading is.

A move within one engine continues the child's own conversation, and its lead
is told. A move to another engine starts a new conversation in the same
workspace, as a hand-off between agents always has — and that continuation is
still the same lead's child, so the lead can steer it and is told when it hands
back.

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
