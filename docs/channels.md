# Channels: beta, general access, and the four image tags

A channel is a pointer, not a build. release-please cuts a version once, those
exact bytes go to **beta**, and **general access** is reached by moving pointers
to them — no rebuild, no second version, nothing re-tested. The build on general
access is byte-for-byte the build that was on beta.

Two facts carry the whole thing:

* **Beta is continuous.** Every released version is on beta. Merging
  release-please's pull request *is* the beta deploy; there is no second gate
  and no way to hold a release back from it.
* **General access is a pin.** A version per package, moved forward
  deliberately by somebody dispatching the `promote` workflow. Beta may run
  arbitrarily far ahead, so promotion names a version and **skipping versions is
  normal** rather than exceptional.

---

## The four image tags

`ghcr.io/firetower-cloud/firetower` and `ghcr.io/firetower-cloud/firetower-updater`
carry four tags. They mean four different things, and only two of them are
channels.

| Tag | What it means | Who moves it |
| --- | --- | --- |
| `stable` | **General access.** The version somebody deliberately promoted. | `promote.yml`, and nothing else, ever |
| `beta` | **The newest released version.** | `images.yml`, on every release |
| `latest` | The newest build published. Its conventional Docker meaning, kept. | `images.yml`, on every release |
| `edge` | The tip of `main`. Unreleased, no changelog, no version bump. | `images.yml`, on every merge |

### Which one to pin

**Pin `:stable`.** That is general access, and it is what `deploy/firetower.yml`
ships with. Pin `:beta` if you want every release as it is cut and have read the
warning below.

**Do not pin `:latest`.** It is not a channel. It keeps its conventional meaning
— the newest build published — and that is exactly why somebody will pin it by
mistake. An installation on `:latest` is told by the channel manifest that
general access is, say, 0.55.0; it pulls `:latest` and gets 0.58.0; the updater
sees a version it was not asked for and **refuses to upgrade at all**. It is
frozen until the image line is changed, and the message it gives names the tag
to change it to.

`:beta` and `:latest` point at the same build today, and always will while every
release goes to beta. That redundancy is intended: one is a channel you may pin,
the other is the convention for whoever pulls by hand, and they would diverge the
moment a release were held back. Neither is a duplicate of the other, and
deleting either as a simplification breaks whichever use it served.

### Switching an installation's channel

An installation's channel **is the tag on the image it is running**. Nothing
stores it — there is no setting and no database row, because a stored channel
could drift from the compose file and produce a version error whose real cause
was a stale row.

So switching is editing both image lines in `firetower.yml` and upgrading.
Both: the control plane and the updater are built and published together and
their API versions are checked against each other on every call, so they cannot
be on different channels.

> **Moving to beta is one-way.** The database migrates forward, and migrations
> are forward-only by design. Going back means restoring a dump and losing
> everything since. Take a backup first.

An unrecognised tag — `edge`, a two-part version like `0.55`, a local build —
is not a channel and resolves to general access.

---

## The desktop app

Three addresses, which are releases carrying a `latest.json`:

| Address | What reads it |
| --- | --- |
| `desktop-stable` | Copies on general access |
| `desktop-beta` | Copies on beta |
| `desktop-latest` | **The address that existed before channels. A permanent alias of general access.** |

`desktop-latest` can never be retired. Every installed copy has its updater
address compiled into its bundle, and the only way a copy ever reads a different
one is by updating — which it can only do through the address it already has.
There is no migration, ever. A copy predating channels therefore stays on
general access forever, by construction, which is the answer to "why am I not
getting betas": take the one hand-install from the beta release page, and from
the next release on that copy auto-updates on beta.

A copy's channel is **its own**, whatever its control plane is on, and it is a
preference stored on the machine. Switching back means "stop receiving new
betas", not "return to the general-access build" — a copy ahead of general
access is never downgraded.

---

## The worker

**The worker has no channel**, and it does not need one. A worker's version is a
function of its control plane's: upgrades run the installer over the ssh
connection the control plane already holds, pinned to the version being moved
to, and nothing ever moves a worker ahead — a worker newer than its control
plane is the same protocol mismatch as one older.

Two paths put a worker on a fresh machine, and they are pinned differently
because only one of them has a control plane to ask.

| Path | What it installs | Pinned by |
| --- | --- | --- |
| **Added through Firetower** — the authorize command, and every later upgrade | The control plane's **own** version | The control plane, which writes `--version X.Y.Z` into the line it hands you |
| **By hand** — `curl -fsSL https://usefiretower.com/worker.sh \| sh` | **General access** | The `worker-latest` release, which is a general-access pointer |

The first is exact whatever channel the installation is on, which is why a
machine added through the interface arrives with the matching binary first time.

The second has nothing to ask, so it takes the pointer — and the pointer has to
be general access. It used to be the newest build, moved by every release, which
was the same thing only while there was one channel. Under a continuous beta it
would hold a **beta** worker from the moment the channels diverged, so somebody
following the install guide onto a general-access control plane would install a
worker newer than it and be refused, having done exactly what they were told.
That is #459, and it is the same defect as #454: a pointer meaning *newest* is
correct only while the channels are equal, and silently wrong afterwards.

So `worker-latest` is moved by `promote.yml` and by nothing else, from the
promoted version's own release — the same files, so the two can never disagree.
A release does not touch it.

**What this does not fix, stated plainly.** The pointer follows the general
access *pin*, and an installation follows it when its operator upgrades. An
installation that has not yet taken a promotion is behind the pin, and a hand-run
install on that machine gets a worker newer than it — which is refused if the
protocol version moved in between. Nothing a pointer can do closes that: the
hand-run path has no control plane to ask. What closes it is the pinned line,
which is what Firetower hands you when you add a machine, and what the refusal
itself prints as the remedy. Following general access makes the window as small
as a pointer can make it, rather than permanent.

> `worker-latest` is named "latest" for the same reason `desktop-latest` is: it
> is the address that existed before channels, every published one-liner and the
> `usefiretower.com/worker.sh` redirect point at it, and renaming it would
> strand all of them. Like `desktop-latest`, it is **a permanent alias of
> general access**. Pass `--version X.Y.Z` for anything else.

---

## The channel manifest

One document says which version each channel points at. For the control plane it
is what every reader consults, and promotion writes it last — which is what
makes it that package's point of no return. For the desktop it is written first,
because the app reads its own addresses rather than this; see Promoting.

It lives on a rolling release of its own — tag `channels`, asset
`channels.json` — because it is mutable by design and cannot live at an
immutable ref, and because the host's own notion of "latest release" is
whichever package released most recently. `worker-latest` and `desktop-latest`
are the same pattern.

```json
{
  "schema_version": 1,
  "control_plane": { "beta": "0.58.0", "general": "0.55.0", "general_promoted_at": "2026-11-01T09:12:00Z" },
  "desktop":       { "beta": "0.21.0", "general": "0.20.0", "general_promoted_at": "2026-10-14T16:40:00Z" }
}
```

Per package, because the packages version independently: a desktop-only release
has no control-plane version to promote, and a single pin could not name it.
`schema_version` is in the minimum because every installation reads this document
forever, including installations older than any later change to it — it is the
one omission that could not be corrected afterwards.

The required CLI version is deliberately **not** here. It stays in
`deploy/cli.json`, read at the ref being offered: the CLI requirement is a
property of the build rather than of the channel, so it already travels
correctly, and duplicating it would make two places able to disagree about it.

**Binding on anything that reads this document:** no document yet is absence; a
document that reads is the answer; **anything else — a rate limit, a network
failure, a document with no version in it — stops and changes nothing.** A read
that goes wrong must never be allowed to look like "general access is at version
zero".

Nor must a *write* that went wrong. Uploading an asset deletes the old one
before it writes the new, so a failed upload can leave the release with no
manifest at all — which would otherwise be indistinguishable from a repository
that has never promoted, and would then accept a version older than the pin it
had just lost. The writer therefore always leaves `channels.previous.json` on
the release first, and a release carrying that but no `channels.json` is read as
a destroyed manifest and stops everything. To recover: check
`channels.previous.json`, confirm it is what you expect, and re-upload it as
`channels.json`.

Two writers can also overlap — a release moving a `beta` pin while a promotion
moves a `general` one. Both read and replace the whole document, so the writer
reads back what landed and, if another writer got in between, re-reads their
document and re-applies its own pins on top. The pins commute and never move
backwards, so this converges and both survive.

---

## Promoting

`promote.yml`, dispatched by hand, taking a package, a version, and a
confirmation field that has to match the version.

The confirmation is there because promotion cannot be undone. Moving a pin
backwards is refused by design, so the irreversible accident is promoting a
*newer* version than intended — and the other refusals are all silent on exactly
that. A mis-click or a stale browser tab is what the retyped version addresses.

**The order is per package, and so is the point of no return.** There is no
single commit point across both, and the rule is the same one in each case: the
last write is the one that package's own readers consult.

| Package | Order | Why |
| --- | --- | --- |
| Control plane | re-tag the images onto `stable` → **write the channel manifest** → copy the worker onto `worker-latest` | Nothing acts on a moved tag until something tells it to want that version, and the updater refuses an image whose stamped version is not the one it was asked for. An installation that pulls in the window is frozen, not moved. |
| Desktop | **write the channel manifest** → rewrite `desktop-stable` and `desktop-latest` | Those addresses are what copies actually fetch, and the app installs whatever is there if the version is greater. There is no second opinion. |

`worker-latest` comes after the manifest for a different reason — it is not a
commit point and general access has already moved by the time it is written.
The question there is which way the window fails. Behind the pin, a hand-run
install gets a worker older than its control plane and the control plane
replaces it over the connection it already holds; ahead of the pin, it gets one
the control plane refuses. An interruption therefore has to leave it behind, and
the re-run finishes the job. A failure writing it means the promotion is done
and the one-liner is stale: the run goes red, says so, and is re-run.

The desktop order is that way round because the other way was a real defect: an
interruption between the addresses and the document left every general-access
copy upgrading on its next check while the document said they had not been
promoted — and **re-running completed the promotion but could not repair it**,
because the installs had already happened. Written this way, an interruption
leaves the document ahead of the addresses, copies stay exactly where they are
because nothing is offering them anything new, and the re-run finishes the job.

Either way a half-finished run leaves every reader where it was, and every step
is idempotent, so re-running is always the answer.

`promote.yml` is the only route to general access. Dispatching the desktop
release workflow with a general-access channel is refused — it would publish to
both general-access addresses with no confirmation, no check that the version is
on beta, and no update to this document.

Images are re-tagged to a staging tag first, checked there for an unchanged
index digest and for both `linux/amd64` and `linux/arm64` by name, and only then
written to `stable` **by digest**. `stable` is therefore only ever written from
an index that has already passed every check. The staging tag,
`promote-<run>-<attempt>`, is left behind: it is not a channel, nothing reads
it, and GHCR has no delete-a-tag call — deleting the "version" would delete the
index `stable` now points at.

A promotion then installs the worker from the published one-liner — unpinned,
exactly as a person runs it — and asserts the binary reports the version just
promoted. `release.yml` has ended that way since before channels existed; it
moved here along with the release it resolves to, because a check that pins the
version would prove the versioned release works and say nothing about what the
unpinned line gets, which is the whole of #459.

It refuses, and moves nothing, on:

* a confirmation that does not match the version;
* a version older than the channel already holds;
* a version that is not published, or not on beta;
* any read of the current manifest that fails for a reason other than "there is
  not one yet".

It also reports how many installations are running the version being promoted,
from the existing telemetry version counts — a beta version is one general
access does not have yet, so counting installations on it counts beta testers.

**That count cannot actually be read today, and the output says so.** The
digests are posted to a collector that is a separate service with no read API,
so there is nothing for the workflow to ask: see #457. Until there is, the step
names the shortfall and points at the ticket. It deliberately does not print a
zero in its place — zero is exactly what a build nobody tested looks like, which
is the judgement the number exists to inform.

When a collector does exist, set the `TELEMETRY_COUNTS_URL` repository variable
to an endpoint answering `?package=<p>&version=<v>` with
`{"installations": <n>}`. A real count of zero is expected rather than alarming:
beta is one-way for a control plane, few will volunteer, and an installation
with telemetry off is invisible. Promotion is not gated on any of this — the
signal informs the decision, it does not block it.

---

## A judgement nothing enforces

`latest` and `stable` only diverge at the first release left unpromoted. Holding
that first release until the channel release has been widely taken shrinks the
population that can be frozen, at no cost. No code will remind anybody of this,
so it is written here instead.
