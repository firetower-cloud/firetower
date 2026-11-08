# The mobile redesign — every state and every path

The build contract for bringing `mobile/` to the design drawn in
`docs/prototypes/redesign/mobile-redesign.html` ("Firetower on a phone —
redesigned").

**Why this file exists.** The desktop redesign shipped in PR #261 and
`docs/redesign-acceptance.md` criterion 6 explicitly pinned mobile to "renders
unchanged". The phone was drawn and never built. This is the list that stops
the build from being a guess: every state is enumerated, so neither the
engineer nor QA has to infer what "done" covers.

**The drawing is the authority.** Where the build cannot match it, that is a
finding to report, not a licence to reinterpret. Where the drawing is silent,
§6 says so by name — keep today's behaviour rather than inventing.

---

## 1. The reference, and how to open it at a state

The committed prototype is `docs/prototypes/redesign/mobile-redesign.html`.
Open it in a browser.

It is **its own state index**. The "Every screen" tab draws all 44 states as
pressable tiles; pressing one takes the document to that tab and state at full
size. That is the reference render for the state of the same name.

State is a single global object, `S`, declared around line 5520. Every row in
§3 gives the exact patch for its state, so a state can also be reached from the
console:

```js
Object.assign(S, { tab:"inbox", era:"home", home:"typing" });   // then re-render
```

`S.theme` is `"light"` or `"dark"`. `S.pose` is one of the five ids in §2.

> The artifact `@firetower-mobile` v54 is one revision **newer** than the
> committed copy: it rewrites the sign-in and connect copy (states 37 and 39).
> Where the two disagree, **v54 wins** — it is the revision the user validated.
> Every other byte is identical.

## 2. The five poses

| id | Size | What it is |
|---|---|---|
| `iphone` | 390 × 844 pt | the baseline; the design came from this width |
| `android` | 412 × 915 dp | the Android baseline |
| `front` | 466 × 951 pt | iPhone Duo, folded — the front panel |
| `innerp` | 669 × 951 pt | iPhone Duo, open, portrait |
| `innerl` | 951 × 669 pt | iPhone Duo, open, landscape |

### The bands are the design, not a breakpoint

Three panel behaviours. Each threshold is the width at which the previous one
would start stealing from the thing being read:

- **Push**, under 600 — the panel gets its own screen.
- **Float**, from 600 — over the top; the conversation keeps its full width
  underneath, and the scrim dismisses it.
- **Dock**, from 914 — beside.

Three numbers that are load-bearing, and each is a trap:

1. **669 must not dock.** It is wider than a phone, so it invites a docked
   panel — and docking there leaves the conversation 329pt, narrower than the
   390 phone this design came from. 255pt once the system tab rail is counted.
   The whole band rule exists to stop that one move.
2. **914, not 820.** 914 is the width at which a column can dock without taking
   the conversation below its measure. The `820` written in the documents is
   that question answered against the window instead, and it is ~90pt early.
   Nothing ships between 820 and 914 today, so it is wrong rather than harmful —
   but it is the number somebody will reach for. Use **914**.
3. **951 is the only pose with room for two things**, and it gets them: a
   340pt column beside a conversation that still clears its measure. The column
   holds the inbox.

Nothing exists between 466 and 669, so the push/float line at 600 has never
been tested by a real screen — the float band has to be right first time.

## 3. The 44 states

Every one is a tile in the prototype's "Every screen" tab. Each must be built
and each must be screenshotted.

**Two are reference drawings, not build targets** — they draw what the redesign
replaces, for comparison. They are marked `REF`. Build 42.

### Answering

| # | State | Prototype patch | Must show | Likely file |
|---|---|---|---|---|
| 1 | The home | `{tab:"inbox", era:"home", home:"both"}` | the greeting; composer pinned at the foot | `app/(tabs)/index.tsx` |
| 2 | Typing into it | `{tab:"inbox", era:"home", home:"typing"}` | on the keyboard, not the indicator | `app/(tabs)/index.tsx` |
| 3 | Nothing waiting | `{tab:"inbox", era:"home", home:"nowait"}` | | `app/(tabs)/index.tsx` |
| 4 | Nothing yet | `{tab:"inbox", era:"home", home:"bare"}` | the greeting stops holding it open | `app/(tabs)/index.tsx` |
| 5 | Seeded from a task | `{tab:"inbox", era:"home", home:"task"}` | | `app/(tabs)/index.tsx` |
| 6 | No repository | `{tab:"inbox", era:"home", home:"norepo"}` | | `app/(tabs)/index.tsx` |
| 7 | Not answering | `{tab:"inbox", era:"home", home:"error"}` | | `app/(tabs)/index.tsx` |
| 8 | `REF` The Dashboard it replaces | `{tab:"inbox", era:"accepted"}` | accepted, then outgrown — **do not build** | — |
| 9 | `REF` Today's Inbox tab | `{tab:"inbox", era:"now"}` | what ships today — **do not build** | — |
| 10 | Workspaces | `{tab:"inbox", screen:"all", era:"home"}` | what "N more" opens | `app/(tabs)/index.tsx` |
| 11 | The peek | `{tab:"inbox", era:"accepted", peek:"w1"}` | hold a row. Drawn on the old era; **build it on the new home** | NEW `src/ui/Peek.tsx` |

### The conversation

| # | State | Prototype patch | Must show | Likely file |
|---|---|---|---|---|
| 12 | Reading it | `{tab:"workspace", comp:"rest"}` | | `app/workspace/[id].tsx`, `src/ui/Transcript.tsx` |
| 13 | An approval | `{tab:"workspace", comp:"ask"}` | the one loud surface | `src/ui/Approval.tsx` |
| 14 | Writing | `{tab:"workspace", comp:"open"}` | | `src/ui/Composer.tsx` |
| 15 | Dictating | `{tab:"workspace", comp:"dictate"}` | a trail, not a meter | `src/ui/Waveform.tsx`, `useDictation.ts` |
| 16 | Working | `{tab:"workspace", comp:"working"}` | send becomes stop | `src/ui/Composer.tsx` |
| 17 | Watching | `{tab:"workspace", comp:"viewer"}` | no composer, and none greyed out | `src/ui/Composer.tsx` |
| 18 | Attaching | `{tab:"workspace", comp:"open", menu:"attach"}` | | `src/ui/AttachMenu.tsx` |
| 19 | The workspace menu | `{tab:"workspace", menu:"ws"}` | | `src/ui/WorkspaceMenu.tsx` |
| 20 | This workspace | `{tab:"workspace"}` → `overview` | team, made, plan | `app/workspace/overview.tsx`, `src/ui/Overview.tsx` |

### The repository

| # | State | Prototype patch | Must show | Likely file |
|---|---|---|---|---|
| 21 | What changed | `{tab:"repo", repo:"diff"}` | | `app/workspace/repo.tsx`, `src/ui/Diff.tsx` |
| 22 | The tree | `{tab:"repo", repo:"files"}` | | `src/ui/Files.tsx` |
| 23 | Shipping it | `{tab:"repo", repo:"ship"}` | one button, one honest label — "Ship" is not a synonym for Commit | `src/ui/Ship.tsx` |
| 24 | One file | `{tab:"repo"}` → `file` | with the strip above it | `app/workspace/file.tsx` |

### Starting work

| # | State | Prototype patch | Must show | Likely file |
|---|---|---|---|---|
| 25 | Tasks | `{tab:"start", screen:"tasks", tasks:"ok"}` | | `app/(tabs)/tasks.tsx` |
| 26 | No trackers | `{tab:"start", screen:"tasks", tasks:"none"}` | | `app/(tabs)/tasks.tsx` |

### Artifacts

| # | State | Prototype patch | Must show | Likely file |
|---|---|---|---|---|
| 27 | The library | `{tab:"art", screen:"artifacts", art:"library"}` | posters, never frames. Two tiles at 390, three at 669 | `app/artifacts.tsx` |
| 28 | Nothing photographed yet | `{tab:"art", screen:"artifacts", art:"fresh"}` | | `app/artifacts.tsx` |
| 29 | Nothing published | `{tab:"art", screen:"artifacts", art:"none"}` | | `app/artifacts.tsx` |
| 30 | Reading one | `{tab:"art", screen:"artifact"}` | the only live bytes in the app | `app/workspace/artifact.tsx` |
| 31 | What it offers | `{tab:"art", screen:"artifact", menu:"art"}` | and what it will not | `app/workspace/artifact.tsx` |

### Connecting

| # | State | Prototype patch | Must show | Likely file |
|---|---|---|---|---|
| 32 | Where is it | `{tab:"connect", screen:"connect", connect:"where"}` | | `app/connect.tsx` |
| 33 | Looking for it | `{... connect:"reaching"}` | | `app/connect.tsx` |
| 34 | Nothing answered | `{... connect:"noroute"}` | | `app/connect.tsx` |
| 35 | Not a Firetower | `{... connect:"notone"}` | | `app/connect.tsx` |
| 36 | Who are you here | `{... connect:"who"}` | url, username, password. **v54 copy** | `app/connect.tsx` |
| 37 | Replace the password | `{... connect:"locked"}` | **v54 copy** | `src/ui/ReplacePassword.tsx`, `app/locked.tsx` |

### The rest of it

| # | State | Prototype patch | Must show | Likely file |
|---|---|---|---|---|
| 38 | Repositories | `{tab:"you", screen:"config"}` | reached from You and the shelf | `app/(tabs)/config.tsx` |
| 39 | Connect a repository | `{tab:"you", screen:"repos", repos:"list"}` | | `app/repos.tsx` |
| 40 | Not authorised | `{tab:"you", screen:"repos", repos:"noauth"}` | | `app/repos.tsx` |
| 41 | You | `{tab:"you", screen:"you"}` | this phone's | `app/(tabs)/you.tsx` |
| 42 | Switching Firetower | `{tab:"you", screen:"you", menu:"servers"}` | | `src/native/servers.ts`, `app/(tabs)/you.tsx` |
| 43 | The notification | `{tab:"you"}` → `lock` | | — |
| 44 | The badge | `{tab:"you"}` → `springboard` | set from the payload | — |

## 4. Light and dark, both first-class

The user's decision, and the drawing's own default (`S.theme` is `"light"`).

Mobile is `userInterfaceStyle: "dark"` today, with a comment in
`mobile/app.config.ts` saying "Dark, always" because `globals.css` had no light
values. **PR #261 added the light branch to that shared sheet.** Mobile now has
to opt in — that is what criterion 6 meant by "until it opts in".

- Light is the design and dark follows from it; neither is a follow-up.
- A theme control offering **System, Light and Dark**, defaulting to System,
  following the OS, surviving a restart. It belongs on **You** (state 41) — the
  phone has no profile menu.
- `mobile/scripts/tokens.mjs` generates the tokens from `web/app/globals.css`.
  It must emit **both** branches. A colour that exists on the phone and not in
  `globals.css` is a build failure, not a review comment — do not hand-write
  hex into a component.

### The dark finding, which is not the desktop's

The desk re-derived its dark and lifted its page to `#1D1D1E`. **The phone does
not follow it to that value.** The phone stays at L\* 3.0: it is one page,
usually OLED, and iOS's own `systemBackground` in dark is pure black. The
desk's complaint was chrome beside content, an adjacency a full-bleed phone
has not got.

What the phone *does* share is the fault in the place a phone keeps it. **Five
surfaces** — the composer, an artifact card, a sheet, a popover, the peek —
were filled with `--p-ground` and separated by a shadow. In light that is
right. In dark the shadow is `rgb(0 0 0 / .76)` over 0.337% luminance, which
renders nothing — so every one measured **ΔE 0.00 against the page**. The
most-used control in the app was drawn in the page's own colour with an
invisible edge.

All five now take `--p-float`, which is the page's white in light and a lift in
dark. **A shadow is a light-theme device**; below ~1% luminance there is
nothing under a surface to cast into, so elevation is carried by the fill.

This is the single highest-value computed-property assertion in the build —
see §7.

## 5. The user paths

States are stills. These are the journeys, and each has to work end to end on a
device.

- **P1 — Cold start to a conversation.** Launch with no server → 32 → 33 → 36 →
  home (1) → open a workspace (12).
- **P2 — The address goes wrong.** 32 → 33 → 34, and 32 → 33 → 35. Both
  recover: back to 32 with the address still in the field.
- **P3 — First-run password.** 36 with the default password → 37 → replaced →
  home (1).
- **P4 — Answer a waiting agent.** 1 → peek a row (11) → answer from the peek,
  without a round trip into the workspace.
- **P5 — Approve.** 12 → 13 → approve → 16 (working) → back to 12.
- **P6 — Write, attach, send.** 14 → 18 → pick a photo → send → 16.
- **P7 — Dictate.** 14 → 15 → stop → the text is in the composer → send.
  Includes permission refused, and no key.
- **P8 — Ship.** 12 → 21 → 22 → 24 → 23 → ship → the label says what it did.
- **P9 — Seeded from a task.** 25 → pick one → 5 → start → 12.
- **P10 — An artifact.** 27 → 30 → 31. And from a turn: a poster in the
  conversation (12) → 30.
- **P11 — Connect a repository.** 41 → 38 → 39 → authorise → back to 38. And
  40 when it is refused.
- **P12 — Switch Firetower.** 41 → 42 → pick another → home, with the new
  server's data and the old server's token still in the keychain.
- **P13 — Notification to conversation.** 43 → tap → 12, cold **and** warm.
  The badge (44) clears.
- **P14 — Theme.** 41 → theme control → Light, Dark, System → every screen
  redraws → restart → the choice survived.
- **P15 — The fold.** 1 open on `innerp` → fold to `front` → unfold. Then
  `innerp` → rotate to `innerl` → the inbox takes the 340pt column.
- **P16 — Background and return.** `socket.tsx` closes to the background and
  reopens, resuming every subscription from its own cursor. A socket the OS
  killed still reports `OPEN` — this is existing behaviour the redesign must
  not break.

### Five things a fold must not lose

The rule that outranks the others. Across any pose change: scroll position, the
composer's draft text, an open menu or sheet's identity, the keyboard's
focus, and an in-flight upload.

## 6. Not in scope — the designer's own list

Named so nobody discovers them. **Do not invent these.** Where the drawing is
silent, keep today's behaviour and say so in the hand-back.

- **Three transitions.** Unfolding with the keyboard up (stated, not verified);
  unfolding mid-upload; a cold start straight into the inner display from a
  notification. The last two are not drawn.
- **The bring-up.** `src/ui/Bringup.tsx` — the one screen where a person waits
  with nothing else to look at, and it is not drawn.
- **Markdown beyond a paragraph.** Headings, lists, links and tables are
  `src/ui/Prose.tsx`'s whole job; only prose and inline code are drawn.
- **The artifact viewer's internals**, the file viewer's three non-text cases,
  several approvals at once, and the three shipping stages after the first.
- **Dynamic Type**, `prefers-reduced-transparency`, `prefers-contrast`. The
  first moves spacing as well as type — a layout change, not a setting.
- **The terminal and annotations.** Phase 6 in the plan, and they are allowed
  to slip.
- **The menu-bar island.** Desktop's, and out of scope here for the same reason
  it was out of scope there.

## 7. How this gets verified

### Screenshots

Every state in §3 at `iphone`. Every state whose layout is width-sensitive at
all five poses in §2 — at minimum 1, 2, 10, 11, 12, 13, 14, 20, 21, 27, 30.
Both themes for every state. Posted to the PR with `gh --attach` so they
render inline, per the `pr-screenshots` skill.

### Computed properties, not eyeballs

A screenshot verifies layout and never a value. Assert on resolved style:

1. **The five float surfaces** — composer, artifact card, sheet, popover, peek
   — resolve to `--p-float` and **not** `--p-ground`, in both themes. In dark,
   assert ΔE against the page is **non-zero**. This is the fault the designer
   caught; a regression here is invisible to the eye and fatal to the design.
2. **No hard-coded colour.** Every colour resolves to a token that exists in
   `web/app/globals.css`. `just gen-check` and `just check-style` pass.
3. **The band thresholds.** At 599 the panel pushes; at 600 it floats; at 913
   it floats; at 914 it docks. Assert on the resolved layout, not a screenshot.
   **At 669 it must not dock** — assert the conversation's computed width is
   never below 390 on any pose.
4. **The composer is pinned.** Its height does not reflow across poses; it sits
   outside the scroller. At 390 with the keyboard up there are 256pt above it,
   of which the greeting, the "Agents waiting for you" heading and the chip row
   are 203 — so what goes under the keyboard is the artifact grid, every time,
   and the ember marks stay on screen in both states.
5. **Contrast.** Every text tier against its own surface, both themes.
6. **Theme survives a restart**, and System follows the OS.

### What a browser cannot verify — device only

Six gestures are specified and **none has been run under touch**. A screenshot
verifies layout and never a gesture:

- the long-press peek (a pointer held still for **420ms** over a row)
- the drag-down out of the composer, 1:1 with the finger from where it was
  grabbed, projecting on release
- the sideways scroll on a diff
- a sheet following a finger
- swipe along the scroll axis, and drag along the control's own axis — both
  have to work, and neither may steal from the other
- the fold itself

These need a simulator or hardware. `mobile/e2e/` has Maestro flows
(`connect.yaml`, `answer.yaml`) as the pattern to extend.

## 8. Open questions — answered, so silence still moves forward

Each has a default. Take the default unless the user says otherwise.

| Question | The default |
|---|---|
| Does the system tab rail inset the content on the Duo, or overlay it? | **Insets**, which is what a sidebar tab bar does; move the thresholds to the measured column. One log line on a device settles it. |
| Does mobile actually want light? | **Yes, following the system.** Confirmed by the user. Reversible in one config line. |
| Is the peek worth a new component? | **Yes** — it is the only thing that makes four waiting agents cheaper than four round trips. If cut, the plain context menu in `docs/mobile.md` is the fallback and nothing else changes. |
| Should the inbox lose its repository grouping entirely? | **Lose it.** The grouping answers "what is this project doing", which is a desk question. |
| Which Duo heights are real? | Only the widths are documented. Use 466×951, 669×951, 951×669 — nothing depends on height except how many rows fit. |
| Does the front panel get the four tabs at the bottom or the trailing rail? | **The bottom** — 466 is a compact width and the system decides this, not us. |
