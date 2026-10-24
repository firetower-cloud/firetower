# Artifacts

Scoping. What an artifact is, why the preview is the wrong shape for one, where
the bytes should live, and the decisions that need an answer before anybody
writes code.

Everything asserted about the current build was read out of this checkout, not
remembered. File and line references are there so a disagreement can be settled
by opening the file.

---

## 1. What is wrong today

Getting an HTML document the agent wrote in front of a person takes seven steps,
and five separate things are wrong with them.

Today: ask the agent to write the file; ask it to serve the file; approve the
command; the dev server holds a process open; press the globe; pick a port out
of `PortPicker`, which guesses by scraping the conversation for numbers
(`desktop/src/preview/ports.ts`); read it in a frame that is about 700px wide on
a 1440px laptop; give up and open it in a browser; lose annotation.

The five problems are independent, and it matters that they are, because three
are cheap and two are the ones that make it feel built-in.

**A. Serving costs a process and a decision.** Nothing in Firetower serves a
file. The only way bytes reach a browser is `preview/proxy.rs`, which opens a
TCP tunnel to a port *something inside the workspace is already listening on*.
So a document needs a dev server, which needs a tool approval, a port nobody
else on that machine took — and the Docker daemon is shared across sessions
(`CONTRIBUTING.md`, "Docker inside a session") — and a process that stays up.

**B. Nothing says an artifact exists.** The conversation has no idea. `ItemKind`
(`crates/ft-core/src/turn.rs:84`) has twelve kinds and none of them is "made you
a thing to look at". A write of `index.html` draws the same row as a write of
`Cargo.toml`.

**C. The reading frame is built for a dev server, not a document.** `PreviewTab`
is back/forward, an address bar, three viewport widths, and a notes rail pinned
at `w-[18rem]`. Around it the `Workbench` keeps its inspector at 368px. All of
that is right for an app you are inspecting and wrong for a page you are
reading, and together they are why it feels cramped.

**D. Full width and annotation are mutually exclusive, on purpose.**
`crates/ft-server/src/preview/annotations.js:10`:

```js
if (window.parent === window) return;
```

In a tab of its own the runtime bails before it draws anything. That is a
deliberate line with a sound reason — there is no trusted panel to talk to — but
its effect is that the only way to read the thing comfortably is the one way
that cannot be annotated.

**E. It does not survive the session, and there is no library.** `reclaim.rs`
sweeps every 60 seconds for workspaces whose sessions have all ended and deletes
the row; the cascade takes the conversation with it. No grace period — the
module says so in bold. So an artifact that lives in the workspace is gone
within a minute of the session ending, and the screen in your first screenshot —
every artifact you have ever made, listed — cannot exist at all.

A design that only fixes A and B produces something smoother than today that is
still not what you showed me. C, D and E are the feature.

---

## 2. The idea, in one line

> **An artifact is a preview whose far end is a file instead of a port.**

Firetower is already an artifact server and nobody has noticed. `preview.rs`
mints signed per-session origins on a wildcard domain; `deploy/Caddyfile` already
holds a wildcard certificate obtained over DNS-01 specifically so those names
verify; `preview/proxy.rs` is a complete reverse proxy with connection pooling
and websocket upgrades; `annotations.rs` injects an element picker into any HTML
passing through it, with CSP nonce handling that has already been got right once;
`preview_annotations` stores the notes and `POST …/annotations/send` delivers
them to the agent as one turn.

None of that needs to be built. The only thing missing is a source of bytes that
is not "a port somebody started".

Everything below follows from taking that seriously.

---

## 3. Where the bytes come from

Three candidates. You raised all three.

### A separate container — no

It buys exactly one thing: artifact JavaScript running on an origin that is not
the control plane's. The signed subdomain already provides that — it is a real
origin, and this product has no cookies at all (authentication is a bearer
token, `auth.rs:362`), so there is nothing on a neighbouring origin to steal.

What it costs is a second deployment unit in a product whose install is
`curl | sh` and one compose file, a second thing to version-match on upgrade,
and another name to certify. The control plane/updater/worker version triangle
is already the thing `CONTRIBUTING.md` warns hardest about. Not worth it.

### The worker serves it — no

The worker is the piece that has to stay dumb. It opens no port by design
(`ft-proto`'s `TunnelOpen` comment makes a point of connecting only to
`127.0.0.1`, so a bad URL cannot turn a worker into a gateway), it is a single
binary dropped onto someone else's machine, and it is upgraded rarely — which is
the stated reason normalisation happens in the control plane and not out there
(`normalise.rs`, "Where this runs, and why it matters"). Teaching it HTTP undoes
the property that makes adding a host easy.

### The control plane serves it — yes

And then the real question, which is not *where* but *when*:

**(1) Read through the tunnel on every request.** `ToWorker::ReadFile` →
`FileOpened` → `FileChunk` already exists and already streams to a browser
(`sessions.rs:1436`, `download_file`). No storage, no publish step, always
current, and — this is the attractive part — **no worker change and no
`PROTOCOL_VERSION` bump**. But the artifact dies with the workspace, needs the
worker reachable, and cannot be read on a phone when the laptop is shut. Which
is to say it cannot be E.

**(2) Snapshot into the control plane when it is made.** Costs a table, a size
cap and a notion of publishing. Buys everything else.

**My recommendation is (2).** Four reasons, in the order I weight them:

1. **It is the only one that produces the library.** Your first screenshot is a
   list of artifacts across conversations. That is not a nice-to-have bolted on
   the end — it is half of what you asked for, and a workspace-bound artifact
   can never have it, because `reclaim.rs` deletes the workspace a minute after
   it ends.

2. **It matches what Firetower is for.** The pitch on the landing page is that
   the work keeps running while your laptop is closed. An artifact that requires
   a live worker to read contradicts the product. Mobile reads and starts work
   (`docs/which-surface.md`); it should be able to read an artifact without a
   machine being awake.

3. **A frozen version is what makes a note mean something.** `annotations.js`
   re-finds a pin by selector *plus* label *plus* a hash of the element's HTML
   (`findPin`). Against a dev server that hot-reloads, pins break constantly and
   that is accepted, because a preview is a moving target. Against a snapshot
   they never break. **Versioning is not bookkeeping here; it is the thing that
   makes annotation worth having.**

4. **It makes the URL stable**, which is what makes it shareable, which is the
   next thing anyone will ask for.

The honest cost: a snapshot is a copy, and a copy goes stale when the agent
edits the file. The answer is that republishing is cheap and the card says `v3`.
That is also exactly how the product in your screenshots behaves.

---

## 4. What an artifact is

A **document the agent made for a person to look at**, with a version history,
owned by whoever's session made it, which outlives that session.

The last clause is load-bearing and is a schema decision with teeth.
`reclaim.rs` deletes the `workspaces` row and lets the cascade take the rest. So
an artifact **must not be a child of `workspaces`**. It hangs off the user, with
a nullable session reference that is for provenance and goes null rather than
taking the row with it.

There is precedent for the reasoning, and it is worth quoting because it was
already argued once in this repository. `docs/skills/key-decisions.md`:

> a workspace is a conversation and cannot be handed over; a skill is a
> document, and filing it into a directory already handed it over.

An artifact is a document too. Same rule, same answer.

That also means **artifacts need a retention story on day one**, not later. The
whole reason `reclaim.rs` exists is that nothing on the session path was ever
deleted and a self-hosted Postgres grew without bound. Shipping a table that is
deliberately exempt from the sweep, with no cap, would re-create that bug on
purpose. So: a byte cap per artifact, a cap per user, and oldest-version
eviction. The policy is §11.

**Provenance has to be copied, not referenced.** This came out of drawing the
library screen rather than out of the schema. That screen shows which workspace
each artifact came from — and if `artifacts.session_id` is an ordinary foreign
key, `reclaim.rs` empties it within a minute of the session ending, so the
column would be blank for very nearly every row. The workspace's name and the
session's id are written onto the artifact as text when it is published. That is
the Recorded discipline from `paths-and-ownership.md` §2 applied to provenance:
a fact about the past, stamped and never updated.

**Where the bytes sit** is a smaller question than it looks. `BYTEA` in Postgres
is the boring answer, it keeps a backup to one thing, and the sizes involved are
small (a self-contained HTML page is tens of KB; the measured worst case in
`workspace-teardown.md` is an agent log at 9.3 MB, and that is already stored
this way). Files on disk under `FIRETOWER_HOME` would be faster and would split
the backup story in two. Start with `BYTEA` and a hard cap.

---

## 5. How one gets made

Three ways, and the right answer uses two of them.

**A skill alone.** Tell the agent to write HTML to a known path. Zero plumbing,
works with every agent. But a skill is a suggestion, and nothing *knows* an
artifact appeared.

**An MCP tool.** There is already a `firetower` MCP server
(`crates/ft-worker/src/approver.rs`) exposing one tool, started by the agent
itself, with the session's unix socket as its way home. Adding
`mcp__firetower__artifact` beside `approve` is a well-worn path and makes
creation an explicit fact rather than a guess.

Two things to know before leaning on it. First, the config is passed only on the
`Asking::Ask` arm (`crates/ft-core/src/lib.rs:222`) — a session that cannot ask
gets no MCP server at all. Second, it is Claude Code plumbing: the ACP path
sends `"mcpServers": []` (`crates/ft-worker/src/acp.rs:314`). An MCP-first
design silently excludes Kimi and would need separate work for Codex.

**Derived from the stream.** The agent writes a file; the control plane notices.
This is the most Firetower-shaped answer, and `normalise.rs` argues the case
better than I can:

> Keeping the raw lines as what Firetower stores has a second payoff: a mapping
> that turns out to be wrong can be corrected and the history re-derived.

It also works identically for all three agents, because all three write files.

### What I would do

**A built-in skill for the writing, derivation for the noticing, MCP later.**

- A built-in `artifact` skill whose entire job is: write a self-contained HTML
  file to `.firetower/artifacts/<slug>/index.html`. Nothing about servers, no
  port, no process. `.firetower/` is already the session's own directory and
  already outside git — attachments live there for exactly this reason
  (`attachments.rs`: "An attachment is an input to the work rather than part of
  it, and a spreadsheet somebody dropped in should not turn up in the pull
  request"). Neither should a mockup.

- The control plane derives the artifact from the normalised stream: a
  `FileChange` whose path is under `.firetower/artifacts/` opens or updates one.
  No protocol change, no worker change, every agent.

- **Snapshot at the end of the turn, not on every write.** One version per turn.
  This is the detail that makes a multi-file artifact work — an `index.html` and
  a `style.css` written in the same turn are one version rather than two
  half-built ones — and it bounds storage to something a person can reason
  about. The bytes are pulled with the `ReadFile` frame that already exists.

- `mcp__firetower__artifact` comes later, if and when the derived form proves
  too loose: a real title instead of a slug, an explicit publish, an atomic
  multi-file bundle. It should be an improvement on something that already
  works, not the thing the feature depends on.

**v1 therefore needs zero worker changes and no `PROTOCOL_VERSION` bump.** Given
how much of `ft-proto`'s header comment is a list of times that went wrong, that
is worth a lot.

---

## 6. How one gets served

Same door as a preview. `preview_first` (`lib.rs:691`) already inspects the
`Host` header before anything else the control plane does.

The hostname grammar grows one shape:

```
<session>-<port>-<signature>.<domain>     a preview, today
<artifact>-<signature>.<domain>           an artifact
```

These cannot be confused, and the reason is a property the current code already
has rather than one to add: ids are `s_` plus a lowercase ULID, Crockford base32
is alphanumeric, so a session label never contains a hyphen. A preview name has
exactly two; an artifact name has one. `resolve` already parses from the right
and already returns `None` when the middle segment does not parse as a port, so
the ambiguous case fails closed today. Length is fine too: 26 + 1 + 16 = 43
characters against a 63-character DNS label.

Everything downstream is unchanged. The wildcard record and the wildcard
certificate already cover it (`deploy/Caddyfile` — and that file's explanation of
why DNS-01 and why not per-name certificates applies word for word to artifacts;
a per-artifact certificate would publish every artifact's name to Certificate
Transparency, which is public and continuously scraped, and the name is the
credential). On a laptop it is `*.localhost` and costs nothing.

What changes is only where the response body comes from: a row instead of a
`TunnelStream`. `instrument()` runs on it exactly as it does now — in fact more
simply, because a self-contained artifact usually carries no CSP of its own and
the nonce-merging path has nothing to merge.

---

## 7. How one gets read

This is the part that actually matters, and the part a "serve it better" design
would skip.

**1. A card in the conversation.** When the turn that made it ends, the chat
draws a card: title, a thumbnail or first lines, the version, and a click that
opens it. This is `ItemKind::Artifact` in the normaliser plus a branch in
`Chat.tsx`'s `Drawn`.

The precedent is already in the build and is close enough to copy:
`WorkspaceImage` takes a path the agent wrote, resolves it against the
workspace, fetches the bytes through the authenticated client and renders them
inline — clickable to open in a tab. An artifact card is that, for a document.

**2. It opens *beside* the conversation, not over it.** Your third screenshot.
`workspace/tabs.tsx` already has this: `open(tab, beside)` puts a tab in the
other half of the split and makes the half if it does not exist, and `useOpen()`
already falls back to a pushed overlay below `xl`. So this is
`open.artifact(id, true)` and almost no new code.

**3. The tab is a document, not a browser.** Drop the address bar, the
back/forward and the viewport switcher — all three exist because a preview is an
app you navigate, and an artifact is one page. What is left: the title, the
version, Annotate, **Expand**, Open in browser, Share.

Notes go in a popover at the point you clicked, the way a note on a file already
does (`desktop/STYLE.md`, "Selecting code starts a note, **where you
selected**"), with the list behind a count rather than a permanent 18rem rail.
The rail is what eats the width, and the width is the complaint.

**4. Expand is a real mode, and it is the fix for D.** The artifact takes the
window; the conversation collapses to a strip; Esc comes back. Annotation keeps
working the entire time, because it is still an iframe inside the app and
`window.parent !== window` still holds.

**This is why I would not make `annotations.js` work in a top-level browser
tab.** It is possible — the popup fallback in `openPanel()` is half of it
already — but it means an unauthenticated panel across origins, a popup the
browser may block, and a second code path for one feature. The browser trip only
happens because reading in the app is uncomfortable. Fix that and the escape
hatch stops being needed. Keep "Open in browser" for sending someone a link,
which is what it is actually for.

**5. An Artifacts screen.** Listing this workspace's artifacts, and — because
they are snapshotted and user-owned — every artifact you have made. Your first
screenshot. Desktop by `docs/which-surface.md`'s rule: bound to you, not to the
organisation. Mobile reads it.

---

## 8. Annotation

Reuse, with one schema change.

`preview_annotations` is keyed `(session_id, port)` and cascades on the session.
An artifact has no port and must outlive the session. So: `port` becomes
nullable, an `artifact_id` column beside it, and the `session_id` cascade
loosens for artifact rows the same way the artifact's own does.

The runtime, the element snapshot, the pin re-finding, the delivery states
(`draft`/`sending`/`sent`/`uncertain`) and the send-as-one-turn path all carry
over untouched. The note's comment is worth keeping true: *"User feedback is
durable: unlike worker projections, drafts cannot be rebuilt."* A note on an
artifact whose session ended last week is exactly that case, which is a second
argument for not letting the cascade take it.

One genuine improvement falls out of snapshotting. Pins currently fail silently
when a page changes under them. An artifact version is immutable, so a note is
always anchored against the bytes it was written on — and a note carried forward
to v4 can be *shown* as made on v3 instead of quietly not drawing.

---

## 9. What the URL is worth

`preview.rs` already says the quiet part out loud, and it is right to:

> on a deployment with a real domain the hostname is publicly resolvable, and
> then the name *is* the credential.

For previews that is a tolerable trade, because a preview is dead in an hour.
An artifact is a thing people paste into Slack, so the same trade is a different
trade, and this needs a decision rather than an inherited default.

The fork:

- **Private by default.** The signature admits you to the origin; the bytes are
  still checked against the asker's access, the same as any other resource. An
  unauthenticated browser gets a sign-in page. Safe, and the Slack paste works
  for colleagues and nobody else.
- **"Anyone with the link"**, explicit, per artifact, mirroring `may_share`.
  Then the signature is the whole of the check, and the product has for the
  first time a URL that hands a stranger real content — which is a line this
  installation has deliberately not crossed anywhere else.

**I would ship private-by-default and leave the toggle to v2**, because the
second is easy to add and impossible to take back, and because "share with
people who already have a Firetower account" covers the stated use.

Two smaller notes. Artifact JavaScript runs on an origin inside the wildcard:
there are no cookies to reach, and tokens live in per-origin storage, so the
blast radius is already small. And the annotation panel is an authenticated
iframe embedded inside untrusted content — already true for previews, the
mitigations are already there (exact-origin `postMessage`, no removal of
`allow-same-origin`), and they carry over unchanged. Do not weaken them for an
artifact on the grounds that we wrote it; we did not, the model did.

---

## 10. The decisions

| | | Why |
|---|---|---|
| **Where it is served from** | the control plane | It already is an artifact server. A container buys only origin isolation, which the signed subdomain already gives. |
| **When the bytes are captured** | snapshot, at end of turn | Live-reading dies with the workspace, which kills the library. End of turn, not per write, keeps a multi-file artifact coherent. |
| **What it hangs off** | the user; session nullable | `reclaim.rs` has no grace period. A child of `workspaces` is gone a minute after the session ends. |
| **How the agent makes one** | a built-in skill; derived by the control plane | Works for all three agents, no protocol bump, no worker change. MCP later for titles and atomic publish. |
| **Where it is written** | `.firetower/artifacts/<slug>/` | Already the session's own directory, already outside git — same reasoning as attachments. |
| **Address** | `<artifact>-<sig>.<domain>` | One hyphen against a preview's two; cannot collide, fails closed on the existing parser. |
| **Default access** | private, checked like any resource | The name being the credential is fine for an hour-long preview and not for something that gets pasted into Slack. |
| **Annotation** | reuse `preview_annotations`, `port` nullable | Runtime, delivery and the send-as-a-turn path are all already right. |
| **Retention** | the artifact until deleted; versions evicted | A table exempt from the sweep with no cap re-creates the bug the sweep exists to fix — but the document is not the thing that grows. §11. |
| **Provenance** | copied onto the row, not a foreign key | `reclaim.rs` would empty a `session_id` within the minute, and the library's workspace column with it. |
| **Reading** | beside the conversation, expandable to the window | The complaint is width. Expand keeps annotation, which the browser cannot. |

Caps to argue about rather than take as given — **5 MB a version**, **10
versions an artifact**, **500 MB a person** — and, more importantly than the
numbers, which direction each one fails in. That is §11.

---

## 11. Retention

An artifact is the first thing in Firetower that is deliberately kept after the
work is over. Everything on the session path is Recorded and swept with its
workspace; everything Placed is a row of a few hundred bytes. This is the first
table that is both kept *and* heavy, so it needs a policy of its own rather than
an inherited one.

### The artifact and its versions are two different questions

**The artifact is kept until somebody deletes it.** No expiry, no sweep. It is a
document, it is Placed, and it has the lifetime a skill has — which is the same
reasoning §4 used to get it out of the workspace cascade in the first place. An
artifact that vanished on a timer would be worse than no artifact: people paste
these into Slack, and a dead link to something you made yourself is a poor way
to discover that there was a retention policy.

**The versions are history, and history is what grows.** They are the cheap
thing to lose, and the rule is three lines:

1. The **latest version is never evicted.** Without it the artifact is a dead
   link, which is the one outcome worth any amount of disk.
2. A **version somebody wrote a note on is never evicted.**
   `preview_annotations` gives the reason in its own first line — *user feedback
   is durable: unlike worker projections, drafts cannot be rebuilt* — and §8 is
   the other half of it: the frozen bytes are what make a note mean anything a
   week later. Dropping them leaves a note pointing at a selector in a page
   nobody can produce again.
3. Otherwise keep the last **ten**, oldest out first, and sweep anything not
   pinned by (1) or (2) after **90 days**.

Which gives the rule a sentence somebody can hold on to: **versions nobody wrote
on are history; versions somebody wrote on are evidence.**

### The caps, and which way each one fails

| | | On breach |
|---|---|---|
| One version | 5 MB | **Refused at publish**, in a sentence |
| One artifact | 10 versions, 90 days | Evicted, silently |
| One person | 500 MB | **Refused at publish**, in a sentence |

The asymmetry is the design, not an oversight. **Evict a version silently;
refuse an artifact loudly.** Losing a version nobody opened costs nothing and
needs no announcement. Silently destroying a document somebody made three months
ago because a quota ticked over is data loss they would never trace — so at the
ceiling, publishing fails and says why. The agent takes that refusal as a tool
error and can repeat it to the person; that is recoverable, and a deleted
artifact is not.

5 MB is the line between a document and an asset. For scale, an attachment may
be 25 MB (`attachments.rs`) and does not persist at all.

### What keeping them forever actually costs

Worth doing out loud, because the instinct is that this is expensive and it is
not. A self-contained page is 20–200 KB; with an image inlined, about a
megabyte. Ten versions of a typical artifact is ~2 MB, so a hundred artifacts is
roughly 200 MB — about twenty sessions' worth of `agent_lines`, which
`workspace-teardown.md` measured at 9.3 MB for a single session. Firetower
already writes and then throws away far more than artifacts would ever keep.

### The numbers live in code, not in the environment

For v1 these are constants, not `FIRETOWER_ARTIFACT_*` variables.
`CONTRIBUTING.md` sets out what a deployment variable costs: the line in
`deploy/.env.example`, a released CLI that writes it, and a `deploy/cli.json`
bump — and it names that last one as "the part that is easy to forget and the
only part anyone finds out about", with `FIRETOWER_UPDATER_TOKEN` as the one
that shipped without it and surfaced months later as an Updates screen that
would not upgrade anything. Add the knob when somebody asks, with the number
they actually hit.

### Where the sweep lives

Beside `reclaim.rs` and in its shape: a predicate, a cap per pass, and a weight
taken before anything goes — `workspace_weight` exists so that "somebody
watching a disk fill can see where it went", and an artifact sweep owes the same
line in the log.

It must not be *inside* the workspace sweep. That one's entire predicate is
"every session in this workspace has ended", which is precisely the event an
artifact is defined to survive.

### Every way an artifact can die

| | |
|---|---|
| The person deletes it | the only intentional route |
| A version is evicted | history only — never the artifact |
| The person is offboarded | only if it is filed at `u/<them>/…` |
| The installation goes | nothing survives that |

And the list that does **not** end one, which is the whole point of §4: the
session ending, the workspace being reclaimed, the host being removed, the
worker never coming back.

Offboarding has to be stated rather than inherited, because it is the split
skills took and it contradicts the workspace rule. `offboarding.md` is
unambiguous that what sits at a personal root dies with the person and may not
be handed on, by an administrator or anyone else. So an artifact filed into a
directory stays and one left at `u/kevin/…` goes — which makes "file it
somewhere shared" something people must be *told*, in that screen's own per-kind
row, rather than something they find out afterwards.

### The one thing this does not answer

If "anyone with the link" ships (§9), deletion and eviction stop being private:
they become somebody else's broken link, possibly in a thread from last quarter.
The likely answer is that sharing pins what was shared, so a shared version is
exempt from rule (3). It is not decided, and it should not be until that toggle
exists.

---

## 12. Not in v1

- The MCP tool. The skill plus derivation is enough to find out whether the
  shape is right.
- "Anyone with the link."
- Artifacts that are not a web page. Markdown and slides are the same mechanism
  with a different renderer, and adding them before the mechanism has been used
  is guessing.
- Artifacts the *person* makes or edits in place. Big, and a different feature.
- Live reload while the agent is still writing. Tempting, and it reintroduces
  the moving target that breaks pins.

---

## 13. Open questions

1. **Does the slug come from the agent or from us?** A model-chosen slug is in a
   hostname forever. Probably: the agent names the directory, the control plane
   slugifies and de-duplicates, and the hostname uses an id rather than the
   slug.

2. **What does end-of-turn mean for a session with several agents?** A workspace
   can hold more than one, each with its own log. The artifact belongs to the
   session that wrote it, but the directory is shared — two agents can write the
   same path. Last writer wins, or namespace by session.

3. **Is `.firetower/artifacts/` right, when the thing was asked for as part of
   the work?** Sometimes a prototype *is* the deliverable and belongs in the
   repository. A later "keep this one" that moves it out of `.firetower/` is
   probably the answer, and it should not block v1.

4. **What does a card show before the thumbnail exists?** Rendering a thumbnail
   means rendering HTML somewhere, which is a headless browser the control plane
   does not have and should not grow. The first screenful of text, or a
   title-only card, is almost certainly enough.

5. **Does an artifact need its own entry in the Rail, or does it live under the
   workspace?** Both, probably — the workspace list for what this conversation
   made, a global screen for everything.

---

## 14. Rough size

Of the four, the first is the one that has to be got right; the rest follow it.

| | |
|---|---|
| Deriving, snapshotting, the table, the cap | the real work — a few days |
| Serving at a signed name, with `instrument()` | small; the proxy entry point and the injector both already exist |
| Annotation changes | one migration and the nullable port |
| Desktop: card, tab, expand, list | the largest surface, and the part people will judge it on |
| The built-in skill | an afternoon |

The thing I would be most careful about is not any of those. It is **resisting
the urge to make an artifact a kind of preview in the code**. They share a door,
a signature scheme and an injector, and they are different nouns: one is a live
port that dies in an hour, the other a frozen document that outlives the
conversation that made it. The shared parts are already factored
(`Names`, `instrument`, `addressed_to`); the lifetimes should not be.
