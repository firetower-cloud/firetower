# The desktop redesign — the drawing beside the build

Criteria 54–61 of `redesign-acceptance.md` name nine screens. They are
examples. **The rule is that every screen in the desktop client matches its
drawing in `prototypes/redesign/desktop-redesign.html`**, and this note is the
record of checking that, screen by screen, in both themes.

It is a working document. A row says what was true when it was last looked at,
and the harness below is how anybody looks again.

---

## How this was checked

The prototype's `Every screen` tab is generated from one table, `SHEET`, which
holds **96 states**. Three scripts drive it:

| | |
|---|---|
| `pnpm shoot:proto` | Reads `SHEET` out of the artifact and photographs all 96 states at the window's own 1280×824, in light and dark. It reads the prototype and writes nothing into it. |
| `pnpm shoot:app` | Drives the running app into the same 96 states against `mock-server.mjs`. A state it cannot reach records **why**, in `index.json`, rather than quietly photographing the nearest screen. |
| `pnpm reconcile` | One sheet per state: the drawing and the build, light along the top and dark underneath. Four panes is the unit that can actually be compared — a contact sheet of ninety-six thumbnails tells you a screen exists and nothing about whether it matches. |

```
pnpm mock &   pnpm dev &   pnpm shoot:proto && pnpm shoot:app && pnpm reconcile
```

Output lands in `.firetower/reconcile/` (ignored). `ONLY=settings pnpm shoot:app`
re-shoots one group and merges into the existing index.

**The mock had to grow before five screens could be photographed at all.**
`/colleagues`, `/teams`, `/teams/:id/members`, `/directories`,
`/directories/:id/grants`, `/secrets`, `/roles`, `/tasks`, `/provider-kinds`,
`/updates/plan`, `/updates/runs`, `/auth/login` and `/setup/*` every one fell
through to the handler's `[]`, so People, Teams, Directories, Vault and Agent
profiles could only ever be drawn empty. `/readiness` answered
`{ ready: true, checks: [] }`, which is what surfaced the "0 things are
missing" defect below.

## What a verdict means

- **matches** — the drawing and the build agree on layout, type, spacing, the
  one primary action, and what the rows carry.
- **differs** — they do not, and the row says how. Fixed rows keep the entry,
  marked, because the next person to look should know what was moved.
- **not drawn** — the prototype has no drawing for this state.
- **not reached** — the harness could not drive the app into the state. The
  reason is recorded; it is a gap in the check, not a pass.

A difference that is **data** — "Northwind" against "Acme", four repositories
against seven — is not a verdict. Only shape, type, colour, weight, wording
and what is present count.

---

## Out of scope, and said so rather than counted as a miss

**The island.** `design-handoff.md` §7 puts it outside this design. It is
untouched, deliberately, and does not appear in the table.

---

## Starting work

| Screen | Verdict | What differed |
|---|---|---|
| Dashboard — two waiting | **matches** | — |
| Dashboard — nothing waiting | **matches** | — |
| Dashboard — nothing yet | **matches** | — |
| Tasks — has work | **differs → fixed** | A bordered card holding a table with column headers (Id / Title / Status / Updated) and a sage "open" pill per row, on a list filtered to one status. Now rows on the page, pills along one filter line, the query on its own line with `sent as …` under it, `▷ Start` on each row. |
| Tasks — nothing open | **differs → fixed** | The headline stayed "0 to pick from." and the column headers stayed drawn over a one-line "Nothing open here." The headline says what it found now. |
| Tasks — not connected | **differs → fixed** | "0 to pick from." and an empty toolbar — no explanation and no way forward. Now the drawing's heading, the sentence about what a tracker is, and the way in. |
| Agent · model · effort | **not reached** | The harness drove the microphone, not the picker; it did usefully photograph the dictation "no key" state, which is a **modal over a scrim** where the drawing keeps dictation trouble inline by the mic. Both still to do. |
| Which repository | **differs** | The drawing closes the sheet with a footer — "**1 checked out.** Each one gets its own copy of the code, cut from its default branch." The build has no footer. |
| Which machine | **differs → fixed** | The readiness note was a **brick band reading "0 things are missing"** with bare "Missing" / "Check again" lines. Nothing was missing. An empty check list is not a failure and says so quietly now. The rows' second line (what the machine is) is still absent. |
| Which profile | **differs** | No search field; no footer explaining what a profile is; the delegation tag is a sage pill reading "manager" where the drawing has a neutral "can delegate". |

## In a workspace

| Screen | Verdict | What differed |
|---|---|---|
| Conversation | **differs → fixed** | Name, repository, agents and the whole toolbar in one 44px band; boxed icon tabs in the right rail; "Commit" for Ship; no context meter; a key-hint row the drawing does not have. All moved to the drawing: a 52px title row, `.gbtn` toolbar, plain underlined rail tabs, `.meter`, and the hints gone. |
| A file | **not reached** | The harness cannot open the inspector's file tree reliably yet. |
| A diff | **not reached** | As above. |
| Preview | **not reached** | Needs a forwarded port; the mock runs none. |
| A picture | **not reached** | No image in the mock tree. |
| Noting code | **not reached** | A text selection needs a real drag; headless Chromium produces none. See `annotate-place.test.ts`. |
| Notes kept | **not reached** | Follows the selection above. |
| Terminal | **differs** | The drawing docks it **above the composer** with a header naming the machine and the working directory. The build puts a thin bar **below** the composer reading "Shell · \<branch\> · ⌘J hides". |
| Find in the conversation | **differs** | The drawing puts the field in the header row, compact, with `2/7 ^ v ×`. The build floats a wide bar under the header, over the conversation. |
| Right-click a file | **not reached** | As "A file". |
| Another agent here | **differs** | The drawing is a sheet: what a second agent in the same checkout means, a row per agent carrying its account, **the ones that cannot start carrying the reason**, and a "Start it on something" prompt box. The build is a small popover with two rows and no prompt, no reasons, no action. |
| Repositories here | **not compared** | The drawing never says what opens this sheet — the prototype reaches it from its own control strip. The build's answer is the repository chip in the title row, quietened; recorded as the build's answer rather than a match. |
| Ship — uncommitted | **not compared** | This mock workspace has three checkouts, so it draws the multi-repository state. |
| Ship — two repositories | **differs** | The drawing's cards carry the **host's mark**, a state **word** on the right, the changed files with +/−, a refusal as an **amber note**, and one filled primary. The build has no mark, a state pill with a chevron, no file list, the refusal as brick body text, a button per repository, and an outlined closing action. |
| Ship — merged | **not reached** | Needs a merged pull request on the mock checkout. |
| Which skills | **differs** | The drawing is a **popover anchored to the chip**: name in sans with the description beneath, a tick, and a footer about what is in context. The build is a **modal over a scrim** with a search field, names in **monospace** with the description inline, a token meter, and Cancel / Confirm. |

## Artifacts and skills

| Screen | Verdict | What differed |
|---|---|---|
| Artifacts — the library | **matches** | Built to the drawing under criterion 54 (`551ed213`). |
| Reading one | **matches** | — |
| Writing a note on one | **not reached** | Annotating needs a selection inside the viewer frame. |
| Notes kept | **not reached** | Follows the selection above. |
| Skills | **matches** | Built to the drawing under criterion 55 (`c53b317c`), and the gallery's primary action is now the filled pill rather than `CreateMenu`'s grey outline. |
| One skill | **to compare** | |
| A new version | **to compare** | |
| Create with AI | **to compare** | |
| Held for review | **matches** | The build lands a held skill on the gallery rather than at the end of a create flow — criterion 43's reading. The card and its two-pixel amber rule are the drawing's. |
| Upload a folder | **to compare** | |

## Agent profiles and agents

| Screen | Verdict | What differed |
|---|---|---|
| Profiles | **differs → fixed** | Small heading, no lede, an **outlined** primary, rows in a bordered card, three coloured chips and a trash icon per row at rest. Now the drawing's: display heading, filled pill, rows on the page, quiet facts, and the closing note. Also renamed **Agent profiles**, which is what the rail calls it. |
| One profile | **to compare** | |
| New profile | **to compare** | |
| Read-only profile | **to compare** | Criterion 39 — no disabled controls — is the thing to check. |
| What it may reach | **not reached** | The scope sheet opens from a profile being edited; the mock's roles are read-only to this user. |
| Agents | **differs → fixed** | Same family as Profiles. Still missing against the drawing: per-account sub-rows, the weekly-limit figures, and "Connect another account". |

## Sources

| Screen | Verdict | What differed |
|---|---|---|
| Repositories | **differs → fixed** | Card versus page; **slug and branch both monospace at rest** (criterion 48); no host marks; no "Not imported yet" section with its explanation. All moved to the drawing. Still missing: "N workspaces open" per row, which the endpoint does not answer. |
| Git hosts | **differs → fixed** | Rows to `.r`, the state as a word with a dot rather than a filled green block, "Add a host" to the filled pill. |
| Connect — choose a way | **to compare** | |
| Connect — device code | **not reached** | Needs a real application; the mock cannot hand back a user code. |
| Connect — paste a token | **not reached** | Follows a probe of a real address. |
| Connect — connected | **not reached** | Follows a token the mock cannot verify. |
| Machines | **differs → fixed** | Card versus page, and the page called itself **Compute** while the rail called it Machines. `stateLabel` said `Online` / `No worker` / `Unreachable`; it says `ready` / `needs setup` / `not answering` now — "this Mac · Online" is the wire showing through. |
| Add a machine | **to compare** | |
| Add a machine — probing | **not reached** | The probe is a POST the mock answers instantly; the in-flight frame cannot be held. |
| Add a machine — no answer | **not reached** | Needs an ssh probe that fails. |
| Add a machine — reached it | **not reached** | Needs an ssh probe that succeeds. |
| Trackers | **differs → fixed** | Rows to `.r`, "connected" as a word and a dot. |

## Settings

| Screen | Verdict | What differed |
|---|---|---|
| People | **differs → fixed** | Rows in a card with dividers, no find field, the closing note folded into the lede. Now the drawing's. **The role pill cannot be drawn**: `Colleague` carries only `id` and `username`, so the drawing shows more than the endpoint offers. Reported, not invented. |
| Teams | **differs → fixed** | Same family as People. |
| Directories | **differs → fixed** | An outlined primary and collapsed card rows only. Now: filled primary, expander, grants indented, a **level menu** per grant rather than three pills on every row, remove on each, and the closing note. |
| Vault | **differs → fixed** | The page was titled **Secrets** while the rail said Vault. The rows were a table with scope and name in monospace and an eye, "replace" and a trash on every one. Now: the name at reading size, the scope beneath, twelve dots at rest, actions on hover, and the access-log line under a revealed value. **The drawing's sub-line says how each secret was made** ("github · made by connecting a git host"); the API returns only scope and path, so the row says where it is filed. |
| This Firetower | **differs → fixed** | The drawing's **facts table** — Address, Signed in as, Running, Your things live at, Connected since — was absent entirely. |
| Who can access | **not reached** | The sharing sheet opens from the thing being shared; the harness reached Directories expanded instead, which is how the fixes above were checked. |
| Where it lives | **not reached** | Opened from a skill or a secret being filed, not from Directories. |
| New directory | **to compare** | |
| Account | **differs** | No avatar; "Forget this Firetower" is dim rather than brick with a trash glyph; the closing note about where account work is done is absent; the rail panel stays open where the drawing collapses it. |
| Account — password held | **to compare** | Criterion 46 — amber, not ember — is the thing to check. |
| Updates — what is running | **differs** | The drawing's headline names the **state** ("build-01 and build-02 are behind."); the build names the version ("0.14.0 is out."). No "This app" card for the client's own build. No per-machine checkbox or reason line. No explanatory paragraph above the machine list. |
| Updates — what it will write | **to compare** | |
| Updates — upgrading | **to compare** | |

## Every list, in all five states

Criterion 49. The drawing uses Repositories to stand for all of them; the five
scenes are `no-repos`, `slow-repos`, `repos-error`, `repos-denied` and an
address nothing answers on.

| Screen | Verdict | What differed |
|---|---|---|
| Has things | **differs → fixed** | With Repositories, above. |
| Empty | **to compare** | |
| Slow | **to compare** | |
| Refused | **to compare** | |
| Not allowed | **to compare** | |
| Server dark | **to compare** | |

## Getting in, and being held at the door

| Screen | Verdict | What differed |
|---|---|---|
| The address | **to compare** | |
| Looking for it | **to compare** | |
| No answer | **to compare** | |
| Not a Firetower | **to compare** | |
| Who are you here? | **to compare** | |
| Replace this password | **to compare** | |
| Name this Firetower | **to compare** | |
| Set up | **to compare** | |
| Held — password reset | **to compare** | |
| Held — mid-setup | **to compare** | |

## Over any screen

| Screen | Verdict | What differed |
|---|---|---|
| ⌘K — the palette | **to compare** | |
| ⌘P — go to a file | **to compare** | |
| Before something is undone | **to compare** | |
| A usage limit is reached | **not reached** | Needs a session whose account reports a limit; the mock reports none. |
| What happens on a limit | **to compare** | |
| A screen that threw | **not reached** | Nothing in the mock throws on purpose. `Boundary` is covered by its own test. |
| Switch Firetower | **matches** | Built and photographed under criterion 12. |
| The profile menu | **matches** | Built and photographed under criterion 3. |
| Dictation — blocked | **not reached** | Needs a microphone permission answer Chrome will not fake. |
| Dictation — key refused | **not reached** | Needs the voice endpoints; the mock answers none. |
| Dictation — no key | **differs** | Photographed by accident: the build draws a **modal with a scrim and a Close button**; the drawing keeps dictation trouble inline beside the microphone. |
| Dictation — server too old | **not reached** | Needs a server under the voice minimum. |
| Dictation — set the key | **not reached** | Needs the voice endpoints. |

---

## What the sweep found that is not a screen

### Restyling a screen does nothing while its components are untouched

Skills was rebuilt to its drawing and still drew a grey outline where the
page's one action should have been a black pill, because that control belongs
to `CreateMenu` and not to Skills. The same was true of fourteen panes and
`config/bits.tsx`. The components are done first now, under the artifact's own
class names, so a fix lands everywhere at once:

`Button` → `.btn .primary .plain .quiet .harm` · `IconButton` → `.gbtn` ·
`Segmented` → `.seg` · `Badge` → `.ttag` · `Avatar` → `.face` ·
`Pop` → `.pop .mi .mhead .mline` · the list page → `.pg .pg-head .lsec .lrows .r`
· plus `.whereto .fsheet .blank .veil/.sheet2 .fld .lvl .tm/.kids/.made
.whead .tabs/.tab .itabs/.itab .meter`.

### Four screens called themselves something the rail does not

| The page said | The rail says |
|---|---|
| Secrets | **Vault** |
| Compute | **Machines** |
| Profiles | **Agent profiles** |
| Commit *(inspector tab)* | **Ship** |

### Two defects found by looking rather than by reading

- **`HostReadiness` drew a brick band reading "0 things are missing."**
  `isReady` requires at least one check, so a server answering with an empty
  list fell through to the failure branch. Nothing was missing.
- **`currentPath()` threw without a `window`.** Half the component tests
  render to a static string under node; the first screen to read the path in
  its own body took eight of them down.

### The workspace Overview's token bar is out

A four-colour stacked bar, `229.8M tokens total`, and a percentage beside
every agent. Four hues in one panel, identity carried by hue rather than by
mark, and a rail that was measurably louder for a figure nobody opens a
workspace to read.

**The numbers were real**, which is worth recording because the feature was
dropped on the belief that any figure would have to be invented:
`POST /api/v1/sessions/token-usage` answers `SessionTokens[]` and is in the
current generated client. It is a future feature rather than a dead end — it
just does not belong in the team rail.

---

## Where the drawing and the build disagree, and the build won

Each of these is a stated deviation rather than an unfinished row.

1. **The repositories sheet's way in.** The drawing never says what opens it —
   the prototype reaches it from its own control strip. The build keeps the
   repository chip in the workspace title row, quietened.
2. **The editor strip with one tab.** The drawing always shows it; the build
   shows it from two tabs up. A strip whose only entry reads "Conversation" is
   a row of chrome saying nothing.
3. **The account line under the composer.** The drawing has no footer at all.
   The build keeps the account and its Switch, because that is the only way to
   hand a running workspace to another subscription — the drawing's fixture
   simply has nothing to switch to.
4. **The source picker on Tasks.** Drawn as "GitHub ⌄" in the artifact; the
   build hides it below two connected trackers. A picker with one option is
   not a picker.

## Where the endpoint cannot answer what the drawing shows

Reported rather than invented.

1. **People's role pill.** `Colleague` is `{ id, username }`. The drawing shows
   "administrator" beside two of six people.
2. **Vault's provenance line.** The drawing says how each secret was made; the
   API returns a scope and a path.
3. **Repositories' "3 workspaces open".** Not on `Repo`.

## One test reversed on purpose

`repos.test.tsx` asserted that the populated Repositories screen carries no
lede — a reasonable call before there was a drawing to check it against. The
artifact puts one sentence under every page heading, populated or not: it is
what makes eleven configuration panes read as one product rather than eleven
lists. The test now says what it was really protecting — one sentence, not a
preamble — and measures it.
