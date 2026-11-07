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
| `pnpm reconcile` | One sheet per state: the drawing and the build, light along the top and dark underneath. Four panes is the unit that can actually be compared — a contact sheet of ninety-nine thumbnails tells you a screen exists and nothing about whether it matches. |
| `pnpm assert:design` | The same states, **asserted rather than looked at**. See *Asserting instead of looking* below. |
| `pnpm assert:connected` | Presses every control that *names* something and asks where it landed. See *Layer 2b* below. |
| `pnpm check:states` | The states a screenshot cannot see — hover, and sequences. |

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

## Asserting instead of looking

Three of the defects the user found — the unpadded `.sk-tabs` strip, the white
band above the inspector, and the rail's invisible hover — were **photographed
by this sweep and not seen**. That is not carelessness, it is the method's
ceiling: nobody reads a hundred and ninety-eight images carefully, and the
hundredth gets less than the first. A pseudo-class never appears in a
screenshot at all, which is why the hover survived two passes.

So the comparison is now partly mechanical.

### Layer 1 — the tokens

`assert-design.mjs` loads the app in both themes, reads the **resolved** value
of every design token out of the running document, and compares it against the
drawing's own `:root` — parsed out of `desktop-redesign.html` rather than
copied into the script, so there is no table to keep in step by hand. The
drawing names the surfaces as furniture (`--desk`, `--sheet`, `--raised`) and
the build names them by position (`--color-ground`, `--color-panel`,
`--color-raise`); the mapping between the two lives in one object in that file
and is the only hand-maintained part.

Then the rule the palette states about itself:

> **Every neutral holds `R = G` exactly.** Ground, panel, raise, overlay, line,
> line-soft, bone, text, dim, mute — all ten, in both themes. Only blue is
> lifted.

**It found one on its first run.** `--color-line-soft` was `#f3f5fb` in light:
green two points above red, which is a different hue rather than a cooler one.
It had been missed by the drawing's own palette pass because it is the one
neutral the drawing has no name for, so nothing had ever compared it. Now
`#f4f4fb` — L\* held to a fraction of a point, the blue lift untouched.
Overridden in `desktop/src/styles.css` rather than `globals.css`, because that
sheet is byte-shared with the web client and criterion 6 holds web still until
it opts in.

### Layer 2 — the rules, against the running app

`design-rules.mjs` walks the DOM at every state the sweep drives — 91 of 99,
in both themes, so the coverage is free — and checks the invariants the
handoff states in writing. Each maps to a defect somebody has already found:

| Rule | What it is for |
|---|---|
| `no-uppercase` | No `text-transform: uppercase` anywhere. |
| `ember-budget` | At most three ember marks on a screen. |
| `mono-only-for-machine-text` | Monospace for paths, branches, versions, hashes and diffs — not for a skill's name. |
| `min-h-0-above-a-scroller` | Every flex column between the window and a scroll container carries `min-height: 0`. The documented trap that once stopped the file viewer scrolling. |
| `contrast-floor` | No text below its floor, **measured against the ground it actually sits on** rather than the one its own rule declares. This is the rule that catches the hover bug, and it catches the class rather than the instance. |
| `page-column-inset` | Every direct child of a page column shares the same inline padding. The `.sk-tabs` bug, as a rule. |

Touch targets are not asserted: a 44pt minimum is a finger rule, and this is a
pointer-driven desk where the drawing's own controls are 30px. Said here
rather than silently skipped.

Results land in `.firetower/reconcile/design-assertions.md` and `.json`, one
row per finding, each carrying **which state, which theme, which element,
expected versus actual**. A red tick with no locator costs more than it saves.

### Layer 2b — does pressing a named thing open that thing?

The user's words: *"Many things like this are not connected, check
everything and fix."* That is a statement about a category, and three
instances had already been found by hand — an artifact tile on the home
opened the library, a skill row in the rail opened Skills, an artifact row
opened Artifacts.

The sweep already presses hundreds of controls and asserts none throws.
**That is a weak assertion**: a control that silently does nothing passes it,
and all three of those did. `assert-connected.mjs` presses every control that
*names* something — what it names comes from the mock's own catalogue at
`/__entities`, so nothing in the app needs tagging — and classifies where it
landed:

| | |
|---|---|
| `connected` | landed somewhere carrying that thing's id, or opened a sheet carrying its name |
| `wrong-thing` | went somewhere else, usually the list instead of the item |
| `it-threw` | it arrived, and the screen there died |
| `opened-in-place` | the address did not move and the screen did — a popover, a disclosure, a tab beside the conversation. **Listed, not failed.** |
| `inert` | nothing happened at all |
| `by-design` | a tab, a filter, a switch, a control that answers a different gesture — recognised and marked, not counted |

**The middle rows are the point**, and both were learned the hard way. The
first full run reported twenty-six controls as inert and *not one of them
was*: the workspace's repository chip opens a popover, an artifact row opens a
tab beside the conversation, a Ship row expands in place. None navigates; all
answer. A check that calls those and a broken row the same thing is the check
that let the original bug through.

`it-threw` came from the one real finding. **Opening a child agent from the
team rail took the whole workspace to the error boundary** — the row navigated
correctly and the screen it arrived at died, which a check that stops at the
URL calls connected. `AccountSwitcher` read `current.data?.limits.find(...)`,
where the `?.` guards `data` and not `limits`; an answer that is *there* but
is not that shape throws. Guarded on shape now, the same lesson as the Skills
review, because `[]` is truthy.

### Triaging it honestly

The first run claimed forty problems and one was real. That is worth recording
because a check with a 2.5% hit rate is one people learn to ignore, which is
worse than not having it. Four faults, all in the harness:

- **It matched against the wrong scene.** The catalogue was fetched once from
  the default scene; states that set their own have their own ids. Fourteen
  findings, one cause.
- **It insisted on one id per name.** Two sessions can share a name, and a
  session and its workspace are one thing to a row that names it.
- **It pressed by position.** An index taken on one render and used on the
  next lands on whatever is there.
- **It pressed the wrong one of two.** `hasText` is a substring filter, so two
  controls naming the same thing resolved to whichever came first — in the
  workspace, the title button, which renames on *double* click and correctly
  does nothing on one. It carries `data-gesture="dblclick"` now.

The same discipline applied to the layer-2 rules: 578 findings on their first
run, 57 after four rules were tightened, with contrast, uppercase and mono
clean. **A rule that fires on every screen teaches people to ignore it.**

### Sequences, which no single screenshot holds

`check:states` covers what a still frame cannot: a pseudo-class, and an
order of events. Two sequences live there now — the rail's hover, on a
current and a non-current destination in both themes, and the panel's whole
collapse story: collapse it, visit three destinations, reload, re-open.

The second one earned its place immediately. After fixing the panel's state
to one answer instead of one per destination, three of its six assertions
still failed, because `Rail.go` also called `setPinned(true)` on every
destination click. Every individual screen in that sequence looks right in a
screenshot; only the order is wrong.

### What this cannot do

Worth being plain about, because a green run is going to get quoted:

- It **cannot tell anybody the design is good.** It compares the build to a
  specification; whether the specification is right is a different question
  and not a machine's.
- It **cannot catch a missing screen.** Nothing asserts about a state that was
  never built — absence has no element to measure.
- It **cannot read copy.** A heading that says the wrong thing in the right
  type passes every rule here.
- It **cannot compare node-for-node against the drawing.** Two separately
  authored DOMs have no correspondence between their nodes, and asserting
  every computed property across them would drown real findings in false ones
  from legitimate markup differences. That is layer 3, and it is a much
  larger job than these two.

It catches **drift**, not **absence**. The sheets and a person reading them
are still how a screen gets compared; this is what stops a compared screen
quietly coming apart afterwards.

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
| Which repository | **differs → fixed** | The drawing closes every picker with a footer, and it is the argument for a picker over a plain dropdown: a list of repositories tells you their names, and the footer tells you that each one you tick is another copy of a checkout. "**N checked out.** Each one gets its own copy of the code, cut from its default branch.", or the bare-workspace line at zero. The machine picker already had its version — the readiness readout. |
| Which machine | **differs → fixed** | Its footer is the readiness readout, which the build already had. The readiness note was a **brick band reading "0 things are missing"** with bare "Missing" / "Check again" lines. Nothing was missing. An empty check list is not a failure and says so quietly now. The rows' second line (what the machine is) is still absent. |
| Which profile | **differs → fixed** | The footer is in, in the drawing's words. The delegation tag was a **sage pill reading "manager"** — green is a verdict colour and being a manager is not a thing having gone well — and is now the drawing's neutral `.chip2` on the recessed surface, reading "can delegate": what the profile *may do* rather than what it is called. **One difference left**: the drawing draws a "Search profiles" field above four profiles; the build shows it only past a handful. |

## In a workspace

| Screen | Verdict | What differed |
|---|---|---|
| Conversation | **differs → fixed** | Name, repository, agents and the whole toolbar in one 44px band; boxed icon tabs in the right rail; "Commit" for Ship; no context meter; a key-hint row the drawing does not have. All moved to the drawing: a 52px title row, `.gbtn` toolbar, plain underlined rail tabs, `.meter`, and the hints gone. **Then, reported by the user:** the title row **spanned the full width**, so the inspector began 52px down the window and the band above it came out the sheet's white. The drawing has `.insp` as a full-height column and `.whead` *inside* `.conv` — two columns, with the rail's tab row level with the conversation's title. Nested that way now; the tell is that `Overview · Diff · Files · Ship` and the workspace name share a baseline. `min-h-0` on both, for `.wsheet → .conv → .cscroll` and `.insp → .iscroll`. The header's inspector toggle also drew in both states, so there were two — showing the rail is a thing you do to the window and lives in the header, hiding it is a thing you do to the rail and lives in `.itabs .right`. |
| A file | **differs** | Reached now. The code header differs: the drawing splits the filename from its directory and says "148 lines, 35 touched" with three controls at the right; the build shows one dimmed path, "35 lines +6 −1" and one control. **And the drawing drops `.whead` entirely when a file is open** — its tab strip sits at the top of the window — so the workspace name, the agent and every workspace control vanish while you read a file. Not implemented: it is a behaviour change with a real cost and the drawing's gate (`S.wb==="chat"`) may be a rendering convenience rather than an intent. **For the designer to confirm.** |
| A diff | **matches** | Reached now. |
| Preview | **not reached** | Needs a forwarded port; the mock runs none. |
| A picture | **matches** | Reached now; a PNG was added to the mock tree. |
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
| One skill | **differs → fixed** | Close already, after the tabs pass. Two gaps in the action row: **"Who can use it" was a bare glyph** among four labelled buttons — the sharing control is glyph-only in the dense toolbars where it also appears, so it takes an optional label rather than every toolbar taking words it does not want. And **Download is absent**: there is no download in the generated client, so it is in *Where the endpoint cannot answer what the drawing shows* rather than here. The asides differ too — the drawing closes with "On by default", the build with an **Access** card the drawing has no counterpart for. |
| A new version | **differs** | **The harness was opening the wrong skill** — `pr-screenshots`, which nobody had dropped a version on — and then clicking Versions, which draws a real screen and not the one the drawing names. Pointed at `deploy-runbook`, the held one, the review is reachable and the two can be compared. They argue differently. The drawing shows **what changed**: a line per file with `changed`/`added`/`same`/`removed` and `+38 −11` against each, under a chip reading "This is your v6, changed — it would become v7", closing with `✓ Keep it as v7` / `Discard` and a note that the executable scripts do not change with this version. The build shows **what it is**: an amber band saying an agent wrote this and it runs code, a facts pair, then every file's full contents inlined. The build's framing is right for a skill arriving for the first time and wrong for a sixth version, where the question is what moved. |
| Create with AI | **differs** | Two answers to the same job. The drawing gives it **a screen of its own** under Skills: "Describe the skill", a paragraph saying an agent writes it and what it produces is held for your review before it can run anywhere, one labelled field with its own help line — "The description is the expensive field: it is in context every turn" — the agent and machine chips, and a footer reading "It opens as a workspace you can watch and answer." beside `Start writing it`. The build **prefills the home composer** with "Create a Firetower skill that" and leaves the rest to the composer. Same mechanism underneath; the drawing's version says what is about to happen and the build's assumes you know. |
| Held for review | **matches** | The build lands a held skill on the gallery rather than at the end of a create flow — criterion 43's reading. The card and its two-pixel amber rule are the drawing's. |
| Upload a folder | **to compare** | |

## Agent profiles and agents

| Screen | Verdict | What differed |
|---|---|---|
| Profiles | **differs → fixed** | Small heading, no lede, an **outlined** primary, rows in a bordered card, three coloured chips and a trash icon per row at rest. Now the drawing's: display heading, filled pill, rows on the page, quiet facts, and the closing note. Also renamed **Agent profiles**, which is what the rail calls it. |
| One profile | **differs → fixed** | **The placement offered two of three.** `Role.placement` is documented as `lead | here | new`, the drawing draws all three with "Let the lead choose" first, and the build had a comment asserting there was no such option. A profile that does not pin a placement is a real thing — the one that works wherever the lead puts it. Added. **Two differences left**: the drawing's chips carry no glyph where the build's do, and the drawing's help line under Placement is "Where a workspace it is given runs." against the build's longer "Where a child runs when a lead delegates to it. Every spawn runs the same way." |
| New profile | **differs → fixed** | Three things, all copy and shape. **The lede was the wrong one** — a new profile has to say what a profile *is* ("A saved way of working. Name it, say what it is for, and decide whether it leads or works."), and the build reused the lede for one you are already reading. **The footer was a plain row** with the primary at the left and no sentence, so the one thing worth knowing before you press — "Nothing is created until you press this." — was nowhere on the screen; it is `.formfoot` now, message first, Cancel then the primary, as the drawing has it. **And the primary was sage-tinted**, which is a verdict colour about something that has not happened yet; it is the ordinary pill. The third placement chip, "Let the lead choose", came with the One profile fix and the drawing makes it the default on a new one. **One difference left**: the drawing puts `Who can use it` on a profile that does not exist yet. |
| Read-only profile | **differs** | **Criterion 39 holds in both, differently.** The drawing keeps the *editing form's shape* and fills it with values — Name, Description, Placement with the three options drawn as chips and the chosen one filled, Machine — so you can see what a copy of it would give you. The build replaces the form with a **facts table**. Both avoid greyed-out controls, which is what the criterion asks. **Two real gaps**: the drawing opens with a notice — "You can use this profile but not change it. *ana* administers `d/eng`, where it is filed — ask there, or make your own copy from it." — carrying a **Duplicate** button, and the build has neither the notice nor any way to take a copy. The drawing also puts a `‹ All profiles` back link above the title where the build puts an `All profiles` button at the top right. |
| What it may reach | **not reached** | The scope sheet opens from a profile being edited; the mock's roles are read-only to this user. |
| Agents | **differs → fixed** | Same family as Profiles. Still missing against the drawing: per-account sub-rows, the weekly-limit figures, and "Connect another account". |

## Sources

| Screen | Verdict | What differed |
|---|---|---|
| Repositories | **differs → fixed** | Card versus page; **slug and branch both monospace at rest** (criterion 48); no host marks; no "Not imported yet" section with its explanation. All moved to the drawing. Still missing: "N workspaces open" per row, which the endpoint does not answer. |
| Git hosts | **differs → fixed** | Rows to `.r`, the state as a word with a dot rather than a filled green block, "Add a host" to the filled pill. |
| Connect — choose a way | **not reached** | The harness times out clicking through to the token paste; recorded as the sweep's one hard failure rather than a pass. |
| Connect — device code | **not reached** | Needs a real application; the mock cannot hand back a user code. |
| Connect — paste a token | **not reached** | Follows a probe of a real address. |
| Connect — connected | **not reached** | Follows a token the mock cannot verify. |
| Machines | **differs → fixed** | Card versus page, and the page called itself **Compute** while the rail called it Machines. `stateLabel` said `Online` / `No worker` / `Unreachable`; it says `ready` / `needs setup` / `not answering` now — "this Mac · Online" is the wire showing through. |
| Add a machine | **differs** | The drawing asks **one** thing — `ubuntu@10.4.0.23`, account and host in one field — under one sentence ("Any computer you can reach over ssh. Firetower puts a worker on it; nothing is installed from this sheet."), then the key, then one instruction: append it to `~/.ssh/authorized_keys`, the probe will fail until you do. Its footer carries "Nothing is created until something answers." and the primary says **Probe it**. The build asks **three** — IP address or hostname, SSH account, Name — has no opening sentence, replaces the one instruction with a paragraph covering authorized_keys, provider consoles, instance metadata, OS Login and CAs, and its primary says **Add it**. The wording matters: "Probe it" is the drawing saying nothing exists until something answers, which is also what its footer note says. |
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
| New directory | **differs** | The drawing opens a **sheet over the page**: a back chevron, the title, why it is being asked ("Whoever makes a directory administers it, so there is no window where one exists with nobody able to decide about it."), the name field, a live slug line ("It will be **d/design**."), and a footer carrying a note beside Back / Create. The build puts an **inline strip at the top of the list** — a field, a `Make it` button and one sub-line. The ledes differ too. Not fixed in this pass; recorded with the drawing's full shape so the next one is mechanical. |
| Account | **differs → fixed** | No avatar; "Forget this Firetower" dim and worded "server"; no closing note; bordered cards where the drawing has a change of ground. Now: a `.face2` monogram beside the name, `.lsec` sections with their notes, `.card1` instead of bordered boxes, the `.warnbar` for the held password, the `.whereto` closing note pointing at Settings → People, and the destructive action in brick saying Firetower. **One component gap found doing it**: the drawing has *two* destructive weights — `.harm`, filled, for the primary action of a dialog that exists to destroy something, and `.danger`, brick text, for a destructive control sitting among ordinary ones. The build had only the filled one, which made the thing you almost never want the loudest thing on the screen. `.danger` added. **One difference left**: the rail panel stays open where the drawing collapses it. |
| Account — password held | **matches** | **Criterion 46 holds**: the band is amber in both themes, not ember. Ember means an agent is waiting on you and nothing else; a password that has to be replaced is the other thing amber is for — you can carry on, but not for long. |
| Updates — what is running | **differs → fixed** | **None of the drawing's vocabulary existed here**: `.upd-row`, `.upd-sec`, `.mach`, `.run`, `.steps`, `.plan-files` and `.diffrow` were absent, so the screen was bordered cards where the drawing has rows on raised ground. Ported whole. The machines are a list with a **checkbox each** and a reason line, under the explanatory paragraph, with `Back up now` and `Plan the update for N machines` beneath them. Two differences remain and are the build's: it carries an `Upgrade to X` action on the control plane's row, which the drawing's fixture never needs because its control plane is already newest; and `HostTarget` has no `kind`, so every machine takes the server glyph where the drawing gives the local one a monitor. |
| Updates — what it will write | **differs → fixed** | The plan was a **modal over the page**, carrying the targets, the file list and the per-file decisions at once — so it covered the machine list you had just chosen from. Now a `.run` panel **on** the page: the targets are ticked in the list, and the panel answers only "what does that write". `write`/`new`/`skip`/`keep` in the `k` column, the one amber `your edits are in the way`, `and N more`, and the drawing's three-button footer. **One deliberate departure**: in the drawing the edited file reads `write` and the button offers to keep it, so the default overwrites your edits. A default that destroys work silently is not a default — the shape and the words are the drawing's and the starting position is keep-mine, with the `k` column saying which is in force. For the designer to overrule if the drawing meant it. |
| Updates — upgrading | **differs → fixed** | A run in progress drew as the line "A run is already in progress." above a machine list you could no longer act on, with the steps folded behind a row in Past runs — the one thing happening was the one thing you had to go and find. Now the run **is** the page: the heading reads "Moving X to Y", and the panel carries the elapsed time, Cancel, and a step per line with the glyphs the rest of the app uses for those three states. **Two crashes found by rendering it**: a run with no steps yet, and a run with no `targets` block; both drew the error boundary. The mock served the run list and not the run, which is why this state had never been photographed. |

## Every list, in all five states

Criterion 49. The drawing uses Repositories to stand for all of them; the five
scenes are `no-repos`, `slow-repos`, `repos-error`, `repos-denied` and an
address nothing answers on.

**Two of these were not style gaps but defects** — a bad answer drawn as a
good one. Both are fixed.

| Screen | Verdict | What differed |
|---|---|---|
| Has things | **differs → fixed** | With Repositories, above. |
| Empty | **differs → fixed** | A one-line "Nothing imported yet." Now the drawing's block — glyph, heading, and a sentence saying how one comes to exist — in each pane's own words. |
| Slow | **differs → fixed** | A line of text that reflowed when the answer landed. Now five rows the shape of the rows that are coming. |
| Refused | **differs → fixed** | **A 503 drew "Nothing imported yet."** `Repos.tsx` read `repos.data` and never `repos.error`, so a server answering with a problem was rendered as a server answering with an empty list — *you have nothing* where the truth is *we could not ask*. |
| Not allowed | **differs → fixed** | Same path as Refused, and now told apart from it: a retry will say the same thing, so there is no retry button. |
| Server dark | **differs → fixed** | **A dead Firetower drew "Pick a git host to start from."** `bare` was keyed on row counts, and a server that is not answering makes every count zero. Now the rows stay, visibly stale, with the reason above them. |

The drawing models a single-list pane; Repositories has two, so its empty state
keeps the second list's heading below the block. Recorded rather than forced.

## Getting in, and being held at the door

**None of these had been looked at**, because the mock answered `0.13.0`
against a `MIN_SERVER` of `0.34.1` — `probe.ts` refused it, so every path
through the flow ended on "not a Firetower".

| Screen | Verdict | What differed |
|---|---|---|
| The address | **differs → fixed** | A 26rem column centred on the bare desk, where the drawing puts the whole flow on the sheet with the window's own corners. Heading, mark, field and primary all moved. |
| Looking for it | **differs → fixed** | A spinner, where the drawing has typing dots and the address being asked. A spinner is the shape for a page that has not arrived; this is a question being put to a machine. |
| No answer | **differs → fixed** | A bordered checklist box and two equal buttons. Now the drawing's `.bad` panel — a brick **rule**, not a brick box; the three VPN questions stay inside it, where a remedy goes. |
| Not a Firetower | **differs → fixed** | As above. |
| Who are you here? | **differs → fixed** | A sage-ringed lock over the organisation's name — a signal colour where nothing has gone right or wrong. Now the `.found` panel naming what was found, fields with glyphs, and a footer that answers the question rather than repeating the way out. |
| Replace this password | **reported** | **The drawing has the app change the password** — two fields and "Replace it and continue". The build points at the control plane's own interface, with the reason written above `Gate` and `Setup`: this app deliberately does not carry a second copy of the screen that decides whether anybody can get in. The *shape* is the drawing's now; the behaviour is not, and that is a ruling to make rather than a thing to quietly pick. |
| Name this Firetower | **differs → fixed** | Frame, mark and field. |
| Set up | **differs → fixed** | Drawn **inside the rail**, so a door offered six ways to go nowhere. The gate replaces the body now. |
| Held — password reset | **differs → fixed** | As above, plus its own treatment: centred, a quiet mark rather than the flow's dark one, two actions side by side, and the line saying what is still true. |
| Held — mid-setup | **differs → fixed** | With Set up. |

## Over any screen

| Screen | Verdict | What differed |
|---|---|---|
| ⌘K — the palette | **differs → fixed** | One flat list where the drawing groups Workspaces from Go to, and no footer. The footer carries the one fact about this list that is not obvious anywhere else: it spans every connected Firetower, and the mark says whose. |
| ⌘P — go to a file | **to compare** | |
| Before something is undone | **differs → fixed** | A bordered card with a tinted strip under its buttons — two surfaces and a rule for a box with four lines in it. One sheet now, actions on the same ground as the words, brick only when the thing is destructive. |
| A usage limit is reached | **not reached** | Needs a session whose account reports a limit; the mock reports none. |
| What happens on a limit | **differs** | The drawing titles it **"When this account runs out"**; the build says "When this account reaches its limit". The drawing opens with the paragraph that explains the default — "Off by default, because switching spends somebody else's allowance. Turning it on is choosing the accounts to try, **in order**; the server does the rest whether this window is open or not, and tries each one at most once." — and has **no checkbox at all**: ticking accounts *is* turning it on. The build leads with a "Switch automatically, in this order" checkbox and scatters the explanation into fragments below. Its footer note, "Saved for this workspace.", is absent. **The populated state is unverified**: the mock has no second Claude Code account, so what the sheet draws with a numbered, removable list could not be compared. |
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

## A specification conflict, for somebody else to rule on

**The drawing has the app replace a temporary password; the build does not.**

`first:"locked"` in the artifact draws two password fields and a "Replace it
and continue" inside the app. `Gate.tsx` and `Setup.tsx` both carry the
opposite position, written down before this sweep: *a password the server will
not accept any work under is replaced in a browser, on the control plane's own
interface, and this app deliberately does not carry a second copy of the
screen that decides whether anybody can get in.*

Criterion 45 says first run must *cover* "replace password". It does not say
which of the two. The screen now has the drawing's shape — frame, mark, type,
the single primary — and the build's behaviour. **Changing the behaviour is a
ruling, not a reinterpretation**, so it is reported here rather than made.

## Where the endpoint cannot answer what the drawing shows

Reported rather than invented.

1. **People's role pill.** `Colleague` is `{ id, username }`. The drawing shows
   "administrator" beside two of six people.
2. **Vault's provenance line.** The drawing says how each secret was made; the
   API returns a scope and a path.
3. **Repositories' "3 workspaces open".** Not on `Repo`.

**A skill cannot be downloaded.** The drawing's skill header offers `Download`
beside `Drop a new version` and `Delete`. There is no download operation in the
generated client — nothing under `skills/` serves the folder back — so the
button would be a control with nothing behind it. Reported rather than drawn.

## One test reversed on purpose

`repos.test.tsx` asserted that the populated Repositories screen carries no
lede — a reasonable call before there was a drawing to check it against. The
artifact puts one sentence under every page heading, populated or not: it is
what makes eleven configuration panes read as one product rather than eleven
lists. The test now says what it was really protecting — one sentence, not a
preamble — and measures it.
