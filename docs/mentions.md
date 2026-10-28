# Mentioning an artifact

Scoping. How an artifact made in one conversation is handed to the agent in
another, and the decisions behind the shape it took. The reasoning, so that
reopening a question later does not mean re-deriving it differently.

---

## 1. What it is

Type `@` in the composer, pick an artifact — made in this workspace or any
other, yours or shared with you — and the agent you are talking to gets it as
context. The pick leaves a chip in the attachment row and an `@slug` handle in
the sentence; the page lands in the workspace while you finish typing; the
message names it under what you wrote.

```
Make it match @pricing — same type scale and the same button weight.

Mentioned artifacts:
- @pricing is "Pricing, three tiers" (v3), published 2h ago from the
  workspace "pricing rework". Page: .firetower/attachments/pricing-v3.html
```

**A mention is an attachment.** That one sentence is most of the design. The
page goes into the workspace through the frame a dropped file takes
(`Action::Attach`), lands beside the other attachments, and is only *named*
in the turn — so it costs the agent no context until it opens the file, and it
works for every agent Firetower drives, because every agent reads files. No
worker change, no `PROTOCOL_VERSION` bump.

---

## 2. The decisions

| | | Why |
|---|---|---|
| **Trigger** | `@` at the caret, the key that already names files | One habit, not two. Read at the caret rather than at the end of the draft, which also fixes a small existing limitation of the `/` and `@` lists. |
| **Where it opens** | Docked above the textarea, inside the composer card | What the `/` list does today. No portal, no clipping, no caret geometry; the card grows upward, the way the model menu opens upward. |
| **Sections** | Artifacts, then Files; eight rows in all, at most five of them artifacts | Titles are words and paths are paths, so the two rarely compete. A `/` in the query is a path and hides the artifacts. Eight is the cap the `/` list has always had. |
| **Ranking** | This workspace's first, then recent; with a query, a title or slug prefix beats a word prefix beats a substring beats the origin | The artifact you just made is the likeliest thing to pass on. `rankArtifacts` in `desktop/src/mentions.ts`, tested on its own. |
| **What a pick leaves** | A chip and an `@slug` handle | The chip *is* the attachment; the handle is how the sentence refers to it. Removing the chip removes its handle. Deleting the handle by hand keeps the chip, as a dropped file would. |
| **How the bytes travel** | `POST /api/v1/sessions/{id}/mention` places the page through the attach frame | Server to worker, no round trip through the laptop, and the same path on a phone later. |
| **Where they land** | `.firetower/attachments/<slug>-v<n>.html` | Outside git and swept with the workspace, like every attachment. Deliberately not under `.firetower/artifacts/`: the client publishes whatever appears there, and a mention must never republish. |
| **Several files** | `<slug>-v<n>.zip`, the way Download already zips | The attach frame carries one file, and a page's assets have to stay beside it. The line under the message says to unzip. |
| **Same workspace** | No copy; the handle names `.firetower/artifacts/<slug>/<entry>` | The agent wrote it. It is already there. |
| **Version** | The latest at the moment of the pick; the chip says so | A frozen copy is what makes the reference mean something later — the same reason annotation works on a snapshot. |
| **Access** | The asker may speak in the session, and may see the artifact | `host_to_speak_in` and `artifact_of` (which is `filed_where`): the two rules that already exist. The client's list cannot disagree with them. |
| **Handle** | The slug; `-2` when a shared artifact shares it | Unique per owner, no spaces, survives a word-boundary regex. The same artifact twice is the same handle. |
| **What the agent is told** | One line per mention, under the text | The text of the turn is the one channel all agents share. Nothing goes into the system prompt and nothing is parsed on the way out. |
| **Library** | None | Forty lines on top of the trigger, list and chips that were already there. Inline pills would replace the textarea that dictation, drafts, autosize and the drop surface depend on. |
| **Mobile** | Same endpoint; later, through the `+` menu | Phones do not type `@`. The menu is already how a phone attaches anything. |

---

## 3. Where it lives

| | |
|---|---|
| `crates/ft-server/src/api/artifacts.rs` | `mention_artifact`, beside `publish_artifact`; `zipped`, shared with Download |
| `desktop/src/mentions.ts` | The format, both halves: ranking, handles, the block the composer writes, the block the transcript reads |
| `desktop/src/ui/Composer.tsx` | The `@` list with its two sections, the artifact chip, the message |
| `desktop/src/ui/Chat.tsx` | The handles and chips in the bubble, opening the artifact beside the conversation |
| `desktop/scripts/shoot-mention.mjs` | The states, photographed against the mock |

The two halves of the format are one file on purpose. The transcript is
strict about what it reads back — a block that does not parse line for line
is left as text — so the composer's writer and the transcript's reader cannot
drift without a test noticing.

---

## 4. Not in this

- **The picture.** The poster could ride inside `images`, so a multimodal
  agent sees the page as rendered. Later, as a per-chip option: it is roughly
  1,500 tokens on every turn after, which is the wrong default for something
  most mentions will not need.
- **Older versions.** The latest at the time of the pick. The library has no
  version browser either.
- **Mentioning a workspace or a conversation.** The same list would take a
  third section; it is a different feature.
- **The receiving workspace's rail.** A mentioned artifact is not *from* this
  session, and the rail counts only those.
- **Mobile.** The endpoint is there; the `+` menu entry is not yet.

---

## 5. Iterating from another workspace falls out

An artifact is owner-scoped and keyed on its slug. If the agent copies the
mentioned page into `.firetower/artifacts/pricing/` and edits it, the client
publishes **v4 of the same artifact** from the new workspace. Under a new
name, it is a new artifact. Nothing had to be built for either.
