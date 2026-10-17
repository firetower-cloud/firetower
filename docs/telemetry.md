# Telemetry

Firetower reports daily counts about your installation. It is on unless you turn
it off, and this page is the whole of what it sends, why it is shaped that way,
and how to stop it.

## Turning it off

**Organisation → Settings**, in the web interface, as an administrator. One
switch for the whole installation — not per person, so turning it off means off
for everybody rather than off-for-me-and-not-my-colleagues.

Turning it off also throws away anything already computed and not yet sent.
Without that, "off" would stop new digests while the ones already made went out
on the next client to connect, which is not what anybody means by off.

The same page shows **exactly what would be sent**, computed on demand. Not a
description of it — the actual document, the bytes a client would post. If this
page and this page's example ever disagree, believe the example.

## What is sent

One document per completed UTC day:

```json
{
  "schema_version": 1,
  "install_id": "08de96b5…",
  "day": "2026-10-14",
  "install_age_days": 83,
  "generated_at": "2026-10-15T00:07:12Z",
  "versions": {
    "control_plane": "0.45.0",
    "courier_desktop": "0.19.0",
    "workers": [{ "version": "0.45.0", "hosts": 3 }]
  },
  "people": {
    "registered": 12,
    "active_today": 7,
    "active_7d": 9,
    "active_28d": 11,
    "teams": 3,
    "active_days_28d": { "01-03": 4, "04-10": 3, "11-28": 4 }
  },
  "activity": {
    "workspaces_active": 14,
    "sessions_active": 23,
    "sessions_by_agent": { "claude-code": 18, "codex": 5 },
    "tasks_worked": 9,
    "task_providers": { "github": 8, "linear": 1 }
  },
  "hosts": { "count": 4 }
}
```

That is all of it. The schema is in `fixtures/digest-v1.json`, and a test fails
the build if what the control plane produces and that file ever drift apart.

## What is never sent

Your code. Your prompts. Repository names, remotes or branches. Task titles or
task keys. Agent account names. Usernames, email addresses, or any identifier
for a person — hashed or otherwise.

There is **no per-person record in it at all**. `active_today` is a number.
`active_days_28d` is a histogram: `{"01-03": 4}` means four people turned up on
one to three days of the last twenty-eight. It exists so that seven people who
use Firetower daily can be told apart from a rotating cast of eleven who each
appear once — which is the only thing the counts on their own cannot say — and
it does that without recording anything about any individual.

This is enforced, not promised. `payload_carries_no_identity` in
`crates/ft-server/src/telemetry.rs` reads the real document and fails on any key
that looks like identity, and on the values of a seeded task key, user id and
organisation id appearing anywhere in the bytes.

## How it leaves

Your control plane never connects out. It writes a digest into a local outbox
and waits; the desktop app collects it and posts it on.

```
control plane                     desktop                    usefiretower.com
  computes one digest  ──────▶  GET  /telemetry/pending
  for 2026-10-14                POST the payload      ──────▶  stored
                                POST /telemetry/delivered
```

Three things follow:

- **A firewalled installation reports as well as any other.** Nothing here needs
  egress.
- **A multi-seat organisation is counted once.** The digest is computed once and
  the first client to collect it acknowledges it; everybody else is told nothing
  is owed.
- **Being offline costs nothing.** A fortnight away delivers a fortnight of
  digests when somebody next opens the app. Undelivered digests are kept for 30
  days and then dropped.

The client is a courier and nothing more. It does not decide what is in a
digest, or whether there should be one — a disabled installation simply has an
empty outbox, so there is no flag in the client to check and no modified build
that can ignore one.

## Identity

`install_id` is `sha256(organisation id + a salt)`. The salt is random, minted
once on your installation, and never sent — so the receiving end cannot recover
your organisation id from it.

It is stable on purpose. A new id every day would make every installation look
new every day, and no question about whether anybody keeps using Firetower would
have an answer.

Ids in Firetower are ULIDs, which embed the moment they were minted, so sending
one would leak when your organisation was created. `install_age_days` says that
deliberately instead, at a day's precision.

## Why the counts are "active" and not "created"

`workspaces_active` rather than `workspaces_created`, and the same for sessions
and tasks. Firetower reclaims a workspace within about a minute of its last
session ending, deleting the row — so by the time a digest for yesterday is
built, most of yesterday's workspaces no longer exist. What survives is the
consumption ledger, which is kept precisely because the question "what did that
cost" is asked after the work is gone.

So these are counts of workspaces, sessions and tracker issues an agent actually
took a turn in. A workspace cut and abandoned without any agent running is not
counted, because nothing durable records that it existed.

## Sending it somewhere else, or nowhere

```sh
FIRETOWER_TELEMETRY_ENDPOINT=https://collector.example.internal/v1/digests
```

Set on the control plane. Clients are told where to post by the control plane
rather than having an address compiled in, so this is the only place it is
configured.
