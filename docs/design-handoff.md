# The desktop redesign — the recipe, and what it cost

Written for a designer who was not there. It is the reasoning behind
`docs/prototypes/redesign/`, and it is meant to be enough on its own: the
artifacts show *what* the interface is, this says *why*, and — more usefully —
what was tried and rejected, so nobody re-litigates a settled question by
accident.

It is not a style guide. `desktop/STYLE.md` is still that, and where the two
disagree there is a section below saying which wins and on what grounds.

---

## 1. The rule everything else serves

> **An agent is waiting on you, or it is not. Everything else is quieter than
> that.**

The old interface had no answer to "what needs me?" because thirty things were
competing to be the answer. The redesign spends almost all of its contrast on
one question and lets the rest recede. Every rule below is a consequence.

### One accent per screen

A screen gets one saturated thing. On the Dashboard it is the ember dots beside
the questions you have been asked; on a configuration pane it is usually
nothing at all. Two accents is two answers to "what matters here", which is the
same as none.

Round one of this work put six ember dots on the Dashboard and was rejected for
it. That is the failure mode: ember is cheap to add and the cost only shows up
in aggregate.

### Ember means exactly one thing

**An agent is waiting on you.** Not "something happened", not "unread", not
"new". It is the only saturated colour in the product and it has to stay rare
or it stops working. `Account.tsx:65` currently uses `ember-tint` for the
must-replace-password banner — that is a second meaning, and the redesign moves
it to amber.

### One primary action per page

The filled button is the thing you came to do. Everything else is plain or
quiet. A page with three filled buttons has made the reader choose which one is
the real one, which is work the design should have done.

The exception, argued and kept: **three inline approval buttons** in the
conversation. When an agent asks a question with named options, those options
are the content, not chrome — burying the third behind a menu would hide
*always* behind *once*. Checked at a 1120px window: the card gets 646px and the
three sit on one row with 207px spare, and `flex-wrap` is the fallback if a
label grows.

### A row is a name and one timestamp

Detail on demand. The old rows carried a branch, a repository, a machine, a
state and a relative time, which made every row a paragraph and every list
unscannable. If something matters enough to be in the row it has to earn the
space against the name; otherwise it belongs in the thing the row opens.

### No ALL-CAPS, and mono only where characters matter

Tracked-out capitals were used as section eyebrows in eighteen places. They are
a decoration that reads as shouting, and they make a heading harder to scan
than sentence case. Monospace is for things where the individual characters
carry meaning — a path, a branch, a code, a key, a diff. A branch name in mono
is right; a section heading in mono is costume.

**The test is whether you would ever read it character by character.** You do
that with `crates/ft-server/src/quota.rs` and with `WDJB-MJHT`. You do not do
it with a skill called `pr-screenshots`, a profile called *Ada, the lead*, or a
person's handle — **those are names, and a name is set in the text face.** This
rule was written in the first draft and then broken in three places, including
a panel of six skills that read as a terminal listing.

### Light is the design; dark follows from it

This is the biggest departure from the app as it stands, which is dark-only.
Designing in dark and deriving light produces a light theme that looks like a
dark theme with the lights on — the contrast relationships are built around a
dark ground and do not invert. Designing in light and deriving dark produces
both honestly, because light is the harder constraint: there is less room above
white than below black.

### Four kinds of overlay, and the test that tells them apart

Written down because this was the fourth thing in the project that was
consistent by luck rather than by rule — and the first three each cost a bug.
`--color-scrim` shipped and **one file in the whole client used it**.

> **Does the thing the overlay is about stay on screen behind it?**
> If yes, it is a popover and must not dim. If no, it is a sheet and should.

| kind | what it is | backdrop | dismiss |
|---|---|---|---|
| **Sheet** | interrupts; what it is about is not on the page | `--color-scrim` | Esc, click outside, Cancel |
| **Popover** | anchored to something you are still reading | **none** — an invisible catcher only | Esc, click outside |
| **Bar** | not modal; the page keeps working | **nothing at all** | its own close |
| **Screen** | replaces the body rather than covering it | opaque surface | the action on it |

**Sheets:** the palette and QuickOpen, all three sharing steps, Confirm, connect
a git host, add a machine, add another agent, what a profile may reach,
repositories here, which port, the five dictation dialogs, the limit hand-off.

**Popovers:** Annotate in both its forms, the five pickers, the context menu,
the profile and Firetower-switch menus.

**Bars:** the find bar — and only that.

**Screens:** the Gate and the Boundary. Both keep the titlebar, which is what
makes Account reachable while the Gate is up.

**Annotate must not dim, and that is the rule rather than an oversight.**
`Annotate.tsx`'s own header argues it: the note opens *where you pointed*
because the whole point of annotating rather than typing into the composer is
that the note is attached to a specific piece of text. Dimming the page would
hide the thing the note is about. It gets an invisible full-screen catcher so
clicking away still closes it, and a lift with a hairline ring so it separates
without a scrim doing the work.

**One scrim value, from the shipped token.** `rgb(22 22 23 / .22)` in light,
`rgb(0 0 0 / .55)` in dark — `globals.css:290` and `:127` verbatim. A scrim is
its own thing rather than a surface at an alpha: `--color-ground` at 40% is a
pale wash on a pale page, and in light the dim still has to be *dark*, which is
the half a surface token cannot express.

**A name that meant two things.** This document had `--scrim` as the composer's
bottom **gradient fade** while the product has `--color-scrim` as the modal
**dim**. An engineer mapping one onto the other would have put a dim where a
fade belongs. The fade is `--fade` now. For the same reason the transparent
click-catcher class is `.catcher`, not `.scrim` — it is the opposite of a scrim
and was a rename waiting to be a bug.

### An artifact preview is a poster, never a live frame

Non-negotiable, and the reason is security rather than taste. An artifact is
untrusted HTML. In an unsandboxed iframe it is same-origin with the app, which
puts the Tauri bridge within reach of it. It is also six page loads, six
runtimes and six sets of timers for a grid of six. So previews are static
images, and the four degraded states — has one, not yet, not possible, failed —
are drawn properly rather than left to a broken-image glyph.

### Share the icon table, not a description of it

The icons are lucide's **published markup** — 102 of them at stroke 1.6, with
real `<circle>` and `<rect>` elements where lucide has them. The mobile work
hand-approximated about forty as single flattened paths at stroke 1.8, and the
result read as "older" without anybody being able to say why. No rule had been
broken: the colour, the size and the spacing were all correct. The *shape* was
somebody else's, approximated.

> **An approximation of a shared asset is the one drift a style guide cannot
> catch.**

The fix was to lift the `ICONS` table whole rather than redraw it better. Any
surface that needs these icons should take that table, not a list of their
names. The same goes for brand marks — see `Brand.tsx` in §5, which is this
failure in its mature form.

### The rail's hover preview is a convenience, not a load-bearing thing

Hovering a rail destination expands its panel without navigating. Stated plainly
because the next surface has to decide whether to build an equivalent: **the
rail works without it.** Focus previews identically, so it is already reachable
by keyboard, and pressing a destination navigates whether or not you hovered
first. What hover buys is one round trip — looking into a destination without
leaving the one you are in.

So on a surface with no hover, an equivalent is a *new feature* to be argued on
its own merits, not a port that must happen. It may well be worth it; it is not
owed.

### An icon recedes; the container carries the state

Icons are **lucide at stroke 1.5**, one weight everywhere, and they sit at
`--quiet` rather than `--body`. A rail glyph is 20px and is *the same weight
whether it is current or not*.

This is the second time the rail has been reworked, from opposite directions,
and the resolution is worth keeping. An earlier pass answered "the icons are
not explicit enough" by making the current one heavier **and** giving it a
lighter background — two signals for one fact — which is what made the rail
read as loud furniture beside a quieter product. The fix is not to revert:

> **Let the glyph recede at every state and let the container say which one you
> are on.** An icon can then be thin and the state still unmistakable.

So the rail's current destination is a **filled square in `--ink` with a
`--sheet` glyph**. It is the one place in the chrome that inverts; everywhere
else marks the current thing with a raised surface. It inverts because the rail
is the only place with no label to help — the glyph alone has to carry it, and
a white pill was the same *direction* as hover, so on and hovered read alike.

The box is **34px with an 11px radius** — 7px of padding around a 20px glyph,
so it reads as a tight square rather than a button-sized tile. **Hover and
current share that one box**, so the rail never changes size under the pointer;
two different geometries there reads as cheap without anybody being able to say
why.

A list row keeps the raised treatment, because the name is already readable and
the row only needs marking. It lost its shadow: white on the desk grey is
already a ΔE 6.2 step, and a shadow on top of that is the same second signal.

### The scale is raised once, not per screen

**Every type size below 28px is 1px larger than the first draft.** Conversation
prose is 17, an agent's question 18, a row name 15.5, a control label 14.5, a
timestamp 13.5. The floor for anything a person reads is **13.5px**.

It was done as a uniform step for a reason worth keeping. A scale earns its name
by making a row the same size wherever it sits, so the unit of change is the
*tier*, never the screen. And adding the same number to everything is the only
move that **cannot** disturb the gaps between tiers — which is the thing that
makes a dense screen readable, and the thing a well-meaning per-screen pass
destroys. Prose sits 1.5px above a row name before and after; a question sits
1px above prose.

**It costs rows, and that is the right trade here.** Measured at the reference
1280 × 824 window: the destination panel still holds 7 of 7, and a configuration
list drops from 6 visible to 5. One row, and the list scrolls. Conversation
prose improves at the same time — the column stays 648px, so the measure goes
from about 81 characters a line to 76, which is further *into* the comfortable
range rather than out of it.

Row minimums grew 2px with it (34 → 36, 40 → 42, 44 → 46, 54 → 58), because a
name and a sub-line each grew a pixel.

### Three weights, and no more

**400 · 500 · 530.** The first draft of this design used fourteen — 420, 450,
460, 480, 520, 540, 560, 600, 650, 700 and the rest — which is not a scale, it
is a slider somebody kept nudging. Three is enough: body, label, heading. If a
thing needs emphasis beyond 530, it needs a different size or more space around
it, not another 20 units of weight.

### Signals are the first namespace, not a fourth

`STYLE.md` says colour is fully spent and that anything new is identified by
shape, weight or position — never by a new hue. That rule is right and it has
been misread, including by this document, as *the product is monochrome except
for ember*. It is not. **The signals are semantic and they already exist**, and
`api/view.ts` carries the one table that assigns them:

| status | tone |
|---|---|
| `working` | slate |
| `blocked` | **ember** |
| `done` | sage |
| `broken` | brick |
| `over` | mute |

The workspace's team rail drew **all five in neutral ink**, which left *asked
you a question*, *working* and *handed back* looking like one grey thing told
apart by an 11px shape. Two inches below it the Plan drew a finished step in
sage — the same word, in the same panel, in two different colours.

> **Reaching for the table that already exists is not spending colour. It is
> stopping a screen from throwing away colour it had already been given.**

So: a handed-back tick is sage, a working agent's dots are slate, a question is
ember, a broken child is brick. No new hue, no fourth namespace.

**Two rules survive that, and they are what keep it safe.**

**Never hue alone.** The product draws a failed child as a round pip. Two rows
above it, a question is a round ember dot — one circle told from another by
colour, which is exactly what the guide forbids and what a dichromat cannot do.
It is a **warning glyph** here instead: a tick and a triangle read apart with
the colour off.

**Ember stays rare, and it is counted.** Sage, slate and brick are quiet by
design — that is why they are the safe moves. Ember is not. After this pass the
busiest screen in the whole document carries **three** ember marks, and the
team rail contributes exactly one. If a change pushes that past three, the
change is wrong.

### A server is a mark, never a colour

Firetowers are told apart by a monogram, not a hue. There are not enough
distinguishable hues, they collide with the signal palette, and a colour-coded
server is unreadable to a dichromat. Note `fleet.ts:49` derives the mark as
`org.slice(0,1)` — Acme and Apex both render "A". That needs a de-duplicating
derivation; the fix is specified, the screen showing it is not drawn.

Host marks are the exception that proves it: GitHub, GitLab and Gitea wear
their own brand colours, because those are somebody else's logo rather than our
identifier.

---

## 2. The decisions, and what each one cost

A decision recorded without its rejected alternative is one somebody will
relitigate. These are the live ones.

### One Firetower at a time

**Decided:** the app shows one Firetower, switched from a menu under the
titlebar, Slack-style.

**Cost:** `Fleet.tsx` — the unified inbox that spanned every Firetower — is
retired. That was a real feature and this removes it.

**Why it is still right, and what carries the thesis:** the "all servers" view
was never what made the product work across Firetowers. The dock badge and
`islandState(fleet)` are unchanged and still span every one of them, so the
machine-wide answer to "is anything waiting" is untouched. What is added back
inside the window is narrower and cheaper: **one ember dot on the rail avatar**
meaning *waiting somewhere you are not*, and one line on the Dashboard naming
the Firetower. `Fleet.tsx`'s headline and its grouping survive as the switch
menu's.

**What was rejected:** keeping the server strip. It cost a permanent 48px of
vertical chrome to answer a question that is asked a few times a day, and it
made every screen slightly about fleet management.

### The home replaces the Dashboard

**Decided:** the first screen is a greeting — *Good morning, what should we work
on?* — with the composer in the middle of the page, and two sections under it:
**Agents waiting for you**, then **Recent artifacts**. Drawn by a second
designer, approved by the user, and folded into `desktop-redesign.html` so there
is one drawing of it. `docs/prototypes/redesign/home-alternative.html` is now a
record of the exploration, not a specification.

**Why:** starting work is what you open the app to do, so the page opens with
somewhere to type rather than with a report. The two things under it are *work
that wants you* and *work you made*, in that order when both exist. Two chips
carry an ember dot and anything past that is a count without one — the constant
is **`DOTTED = 2`**, and the budget is three ember marks on screen with the
rail's avatar taking the third.

**What it costs, recorded honestly by the designer who drew it.** The answer to
*is anything waiting on me* moves from a **34px headline about 12% down the
window** to a **14.5px chip about 63% down**. The agent's own question — the
thing you would actually answer — leaves the page entirely. And both sections
now wear the same heading at the same size and colour, so the only thing
separating work that wants you from work you made is **an 8px dot**.

**What still carries the thesis is untouched.** `App.tsx:85` and `:97` — the
dock badge and the menu-bar island — sum across every Firetower and do not
change. The machine-wide answer to *is anything waiting* was never carried by
this screen, which is the same reasoning that made retiring `Fleet.tsx`
affordable.

**Superseded, not deleted.** The Dashboard this replaces — a headline counting
the waiting agents, with their questions on the page — was accepted, built, and
then replaced. It is drawn beside the home in `home-alternative.html`, which is
where the comparison belongs. A design that was right and then outgrown deserves
the same record as one that was rejected.

### The workspaces panel is status-ordered, not status-grouped

**Decided:** flat, sorted needs-you → working → done → broken, newest within
each, with **one hairline and a word** where the band turns. A **Status /
Repository** switch on its own row under the header.

**Rejected, and worth keeping rejected:** *status-grouped*, with a real section
per state. It is the clearest of the alternatives at seven rows and it is the
one not to ship, because **a workspace changes state while you are looking at
it and the row you reached for jumps to another section** — the fuller the
panel, the further it jumps. A list whose order is the thing that is changing
is a list you cannot aim at. Also rejected: repository-first, which at forty
workspaces with thirty in one repository is a wall under one heading with
needs-you scattered across six groups.

**Roll up `BEAT`, not `doing()`.** `doing()` is nearer to hand and is the wrong
function: it returns `waiting | working | idle`, and its *waiting* spans
`NeedsYou`, `HandedBack` **and** `Failed`. `view.ts` argues it in its own words
— *"finished, blocked and broken are three different things to feel, and a
product that paints them the same has told you to go and look without telling
you what at."*

**What the drawing shows that the data cannot yet fill.** There is **no "done"
and no "broken" at workspace level**: a finished place, a never-started one and
one whose run failed all return `idle`. The *Done* and *Broken* bands need a
`beatOfPlace()` beside `doing()` in `api/workspaces.ts`. **Implied work, named
rather than designed around** — no server change, the statuses are already on
the wire.

**The panel draws no ember in Status mode, and that is a measurement.** Rows
carry no mark: the band above already says *Needs you* and counts them. A dot
per blocked row put **five** ember marks on the Dashboard against a budget of
three — the chips, the rail avatar and the panel all answering one question.
Without them it is **3** on the Dashboard and **1** everywhere else. In
Repository mode the band is a repository, so status has nowhere else to live
and the dot returns, capped at two.

**The switch is on this panel only.** It is the one panel holding a set big and
heterogeneous enough for a second grouping to pay. Tasks already picks its
tracker, Artifacts has grid-or-list, and the configuration panels are fixed
lists of panes. A control that appears on one panel needs a reason; that is the
reason.

### Six destinations, not twelve panes

**Decided:** a 62px icon rail with six destinations — Dashboard, Tasks,
Artifacts, Skills, Repositories, Machines — plus two settings doors at the
foot, and a per-destination panel beside it. The Configuration screen is gone;
its panes live in the destinations they belong to.

**Rejected:** merging Repositories and Machines into one destination called
something like "what a workspace is made of". It is one fewer icon and it reads
cleanly, but it buries reachability one level down and there is no honest name
for the pair that is not a category word. **If six ever feels like too many,
that is the first merge to make.**

Also rejected: resting labels under the rail icons. They doubled the rail's
width for information that hover and focus already give, and the six
destinations are stable enough to learn.

### The composer shelf, and why there is none in a workspace

**Decided:** the Dashboard composer carries a shelf above the input — the
repository, the machine, the profile. A workspace composer does not.

**Why:** on the Dashboard those choices are *unmade*, and making them is the
act of starting work. Inside a workspace they are *settled* — the checkout
exists, the worktree is cut, the agent is running somewhere — so a shelf
repeating them is furniture that implies they are still open. The workspace
composer keeps a footer row for the things that genuinely still change: skills,
model, effort, what happens on a usage limit.

### People and Teams are read-only, and say so

**Decided:** no disabled controls anywhere on those screens. Each page ends
with a line naming where the thing is done and why.

**Why:** a greyed-out *Invite* button is the clearest possible way to tell
somebody they are being withheld from. `docs/which-surface.md` owns this rule —
people and teams are organisation-shaped and belong to the administration site
— and the design's job is to make that read as a boundary rather than a
refusal. Directories next door, which the desktop does own, are generous by
contrast, and the contrast is the point.

### Adding a git host does not ask which host

**Decided:** you type an address and the probe decides whether it is a GitHub,
a GitLab or a Gitea.

**Why:** `providers.zod.ts:113` already says it — the address answers that
question, and three logos crowd the row before a fourth kind exists. Drawing a
provider picker is a plausible-looking mistake; it was nearly made here.

What *is* per-host and must be drawn: **Application ID** on GitLab against
**Client ID** elsewhere, each host's own registration steps with the trap in
bold, and the reason the browser route is unavailable — Gitea has no device
flow at any version, a GitLab below 17.9 has none either.

---

## 3. Where this departs from `desktop/STYLE.md`

`STYLE.md` still exists and still disagrees with this design in places. Where
they conflict, **this document wins for the redesign and `STYLE.md` wins for
anything shipped today**, until somebody reconciles them.

| | `STYLE.md` | Here | Why |
|---|---|---|---|
| Scheme | dark only | light first, dark derived | §1 |
| List row | 34px | 32 for chrome, 46 for content | reading rows were too tight to scan |
| Eyebrows | ALL-CAPS section labels | none | §1 |
| Colour | "fully spent" on signals | still spent, plus a light branch | the floors are in §4 |

**`STYLE.md`'s density table is wrong.** It claims a 34px list row three times
(lines 51, 56, 105) and says "34px is the measurement the whole inbox is built
on". No window row is 34px. `styles.css` defines `--row: 40px` and
`--row-tight: 32px`, `.row` uses `min-height: var(--row-tight)` — so the shipped
row is **32px** — and the only literal 34 in `desktop/src` is an `h-[34px]` in
`island/Island.tsx:577`, which is the menu-bar pill and not a list row at all.
Anybody measuring against that table is measuring against a number that is not
in the code.

---

## 4. The tokens

The shared sheet is `web/app/globals.css`. It is dark-only today and it is
**shared with the web client and compiled into
`mobile/src/design/tokens.generated.{ts,js}`**, so a careless change to it
reaches three clients at once.

### The migration shape

Keep every current value as the **dark branch**. Add light under
`[data-theme]`, with a `prefers-color-scheme` default. Then neither web nor
mobile moves until it opts in, and no call site has to change.

**The mechanism leaves a decision, so here is the default.** Opting in is
expected, not optional-forever: a token set with a light branch that nothing
uses is a maintenance cost with no return. Mobile should take it and follow the
system — a phone goes outdoors in sunlight and into bed at midnight, and
`app.config.ts` pins `userInterfaceStyle: "dark"` for exactly one stated reason,
that the token set has no light values. This work spends that reason. If the
answer is no, it is one config line to reverse.

### The derivation method

Each light value is the dark value with **L\* lowered or raised while a\* and
b\* are held**, so the hue and its chroma direction survive, until it clears a
stated floor. Which floor depends on what the colour is measured *against* —
and that is the part worth copying, because it is where the first attempt went
wrong.

* **File kinds and chart series** are measured against the page. The floor is
  whatever the dark set's own weakest member clears on `#111113`: **5.7:1** for
  a kind, **4.8:1** for a series.

  **There are seven file kinds, not nine.** `globals.css`'s own comment says
  "Nine categories, not ninety formats" directly above a list of seven, and the
  number travelled from there into `desktop/STYLE.md`'s palette table, the
  phone's `FileGlyph`, both redesign artifacts, and this document's reader.
  **Eleven hues were re-gated, not thirteen** — and the "thirteen" in the Spec
  tab's *implied work* table was the same nine, added to four series, which is
  how an error of this kind pays for itself twice. All of it is corrected,
  including the artifacts: the Spec tab opened *The light palette, re-gated*
  with "Nine file kinds" two lines above a grid of seven swatches.

  Left alone deliberately: the invented agent question on the Dashboard mock,
  which asks about "the nine file colours". It is sample copy under a banner
  saying every name and question below is invented, and agents are allowed to
  be wrong.

  A count quoted from a comment rather than counted from the list is the
  cheapest error there is to make and the most expensive to notice.
* **Syntax** matches *its own* dark ratio rather than a common floor, because in
  that set the ratios *are* the design — comment is deliberately the faintest
  thing on the page. Chroma is additionally capped at **C\* 34** so no syntax
  colour out-shouts the quietest signal.
* **Signals** are measured against **the neighbour they actually sit on**. A
  badge is composed the same way in both themes — the colour on its tint, inside
  its deep — so `--color-amber` is gated against `--color-amber-tint`, not
  against the page. Measuring it against white produced a value that was
  technically fine and visually wrong.

### The honest exceptions

Three, stated rather than hidden. A derivation that reports only its successes
is not a derivation.

**Tritanopic separation of adjacent chart series is weak in both themes** —
2.8 in dark, 1.6 in light. Rotating series 3 and 4 in Lab was tried and cost
more protanopic separation than it bought. The mitigation is the existing house
rule: a series is **directly labelled and never keyed by colour alone**. File
kinds have the same weakness under deuteranopia in both themes, and the same
mitigation — every kind carries a glyph in the tree.

**`syntax number` travels worst.** Holding its dark ratio on white drives a
wheat yellow to a dark ochre, and the chroma cap takes another six points off
it. It is still unmistakably not a string or a keyword, but it no longer reads
as "yellow". The alternative — letting numbers sit at the set's floor instead of
their own — is available if that matters more than matching the ratio.

**Amber needed a second step.** It is the first of the two tokens this work adds; the second is below.
`--color-amber` is used two ways: as *text* on `--color-amber-tint` (the
*needs review* tag and its `ShieldAlert`, `config/Skills.tsx:455` and `:687`),
and as a *mark* on the page — a status pip, a meter fill, a 2px rule. In dark
the tint is dark and the ground is dark, so one value does both. In light the
tint is pale, text on it must clear **8.75:1**, and that drives amber to L\* 27
and C\* 42 — `#653400`, which is correct, legible, and **brown**. A quota meter
filling with brown no longer says "still working, but not for much longer",
which is the reason `globals.css` gives for amber existing at all.

So **`--color-amber-soft`** is added: `#A8780F` in light, past the **3:1** floor
for a non-text graphic and still recognisably amber, and **`#fab219` in dark —
identical to `--color-amber`, so no dark-mode pixel moves anywhere**. It follows
`--color-ember-soft`, which is the existing precedent for a second step inside
one signal namespace, so it is not a new namespace.

The rule for applying it: **`--color-amber` where it is text on
`--color-amber-tint`; `--color-amber-soft` where it is a mark on the page.**

### Ember needs the same thing, and the token for it already exists

This work adds **two** tokens, not one. The second is `--ember-ink`, and it was
derived into the desktop artifact and never written down — which is how the
mobile designer hit the problem fresh.

In the ember namespace `-soft` is mostly the *text on the tint* —
`text-ember-soft` on `bg-ember-tint`, at `Titlebar.tsx:44`, `Chat.tsx:1527` and
six more. That is the reverse of amber's split. Both are consistent on the thing
that actually matters:

> **`-soft` is the lighter of the pair in either theme. Where a token is text on
> its own tint in light, it needs an `-ink` step.**

The roles swap because text on a *dark* tint has to be the lighter value and
text on a *pale* tint has to be the darker one. So:

| | lighter member | darker member |
|---|---|---|
| amber | `--color-amber-soft` — a mark on the page | `--color-amber` — text on its tint |
| ember | `--color-ember-soft` — text on the dark tint | **`--ember-ink`** — ember where it has to be read in light |

`--ember-ink` is `#BF4714`, measured **5.09:1 on white**. It is in
`desktop-redesign.html` twice and in `globals.css` zero times; it needs a
`--color-` prefix and a home in the shared sheet alongside the amber pair.

**And the same honest exception applies.** If a light ember *badge* is ever
needed — ember text on a pale ember tint — matching the dark pair's 8.34:1
drives it to `#970100`, a dark red that no longer reads as ember. That is the
same trade amber made at `#653400`. Whoever needs it should decide knowingly
rather than discover it.

### Every neutral holds R = G

> **The shipped dark scale raises blue and never green.** `--color-ground`
> through `--color-line`, and `--color-bone` through `--color-mute`: **`R = G`
> on all ten, without exception.** Light must do the same.

This is the rule behind `globals.css`'s own note that the hue is neutral on
purpose — *"the warmth in this app belongs to the ember, not to the walls."*
A controlled blue lift reads as a cool grey. Raising **green as well** reads as
a different hue, and that is what the first light derivation did: every light
neutral had green 1–3 points above red. Beside a neutral product it looked like
a blue-grey cast, and it was correctly reported as one.

Fixed across all nine, each holding its old L\* to within 0.15 so no contrast
ratio moved by more than 0.03:

| | before | after | |
|---|---|---|---|
| `--desk` | `#ECEEF1` | `#F2F2F3` | and lighter — see below |
| `--raised` | `#F5F6F8` | `#F6F6F9` | |
| `--sunk` | `#E6E8ED` | `#E8E8EC` | |
| `--hair` | `#E3E5EA` | `#E5E5EA` | |
| `--ink` | `#15161A` | `#161617` | 18.08:1 unchanged |
| `--body` | `#45474F` | `#47474D` | 9.26 → 9.23:1 |
| `--quiet` | `#787B85` | `#7B7B83` | 4.22 → 4.20:1 |
| `--hush` | `#A4A7B1` | `#A6A6AF` | 2.40 → 2.42:1 |

**The artifact's own dark branch had drifted too**, found while checking this.
Its dark neutrals were not `globals.css`'s — `--desk` was `#060608` against the
real `#0b0b0c` — and five of the nine carried the same green contamination.
§4 says the dark branch *is* the current values; the drawing disagreed with the
document. All nine are now `globals.css` byte for byte, so **both themes hold
`R = G` on every neutral** and the light ladder mirrors dark's blue lift by
role: surfaces +1 / +3 / +4 / +5, text +1 / +6 / +8 / +9.

**The translucent blacks carried it too.** Thirty-one uses of
`rgb(21 22 26 / …)` — every hover, shadow and scrim — are now
`rgb(22 22 23 / …)`. **That is what made the rail hover look wrong**: a 5%
black with a blue bias over a blue-cast ground concentrates the cast exactly
where the eye is. The hover rule itself was never the problem, which is worth
remembering — *a tint that looks wrong is usually the thing underneath it.*

### The ground's lightness is a separate decision

`--desk` went `#ECEEF1` → **`#F2F2F3`**: neutral, and ten points lighter.
Deliberately **not** Codex's `#f6f6f6`, which was the comparison that prompted
this. At `#f6f6f6` the chrome-to-sheet step falls to **ΔE 3.1**; at `#F2F2F3`
it is **ΔE 4.5**, down from 6.2 and in the same family as the rest of the
ladder (sheet → raised 3.4, raised → sunk 4.9).

The step is doing structural work here that it may not be doing in the thing
being compared to: **this window is a rounded card floating on that chrome**,
not a flat page. Halving the only figure-ground boundary in the design to match
a hex value is the wrong trade. `#f6f6f6` remains available and costs exactly
the ΔE 3.1 above — it is a judgement, not a constraint.

### The greys were measured and left alone

Worth recording because it was nearly changed. In light, `--sunk` (a recessed
fill) and `--hair` (a hairline) sit **ΔE 1.1** apart — the same colour under two
names — where the dark branch holds a clean **3.7**. Two fixes were tried and
both were worse than the overlap:

* **Merging them** lightened every recessed fill in *dark* by ΔE 3.7, because
  dark's pair is a legitimate step. A light-branch fault is not a token fault.
* **Separating them in light** means a **darker hairline**, and this design is
  trying to draw fewer and fainter lines, not stronger ones.

They are never adjacent — a fill and a rule inside the same 2px of screen does
not occur — so the overlap costs nothing. **No surface token moved.**

The general lesson is still worth having: **derive a light scale as a ladder**,
each rung measured against its neighbour rather than against the page, or the
bottom rungs collapse into each other without anybody noticing.

### When the drawing and the build disagree, measure

`--color-sage` light: the drawing had `#2F7D52`, the build shipped `#00582b`.
**The build was right and the drawing was wrong by its own rule.** §4 says match
the dark pair's ratio against the same neighbour; dark sage holds **8.60:1** on
the panel, `#00582b` holds **8.64:1** on the sheet, and `#2F7D52` holds 5.03.

The general point is worth more than the value: **a shared token is not moved to
match a drawing.** `globals.css` reaches three clients, so the burden is on the
drawing to justify a change, not on the build to absorb one. Reconcile toward
the shipped value unless the drawing can show the shipped one is wrong.

### Host marks

`--color-host-github` is `#f4f4f5`, which measures **1.10:1 on white** —
invisible. GitLab's orange measures 2.86:1, under the 3:1 floor. Each takes its
own brand's light-mode mark rather than a derived one, because a logo is not
ours to reinterpolate: GitHub `#1B1F23`, GitLab `#E24329`, Gitea unchanged.

---

## 5. Components: the duplication is the bug

`desktop/src/components/ui/` and `web/components/ui/` ship **eleven identically
named components**. All eleven were diffed:

* **Ten are byte-identical** — Avatar, Badge, Button, Card, Copy, Field, Icon,
  IconButton, Panel, Segmented.
* **`List.tsx` differs by exactly one line**, its `Link` import. That is not
  drift; it is the shim mechanism working as `which-surface.md` describes.
* **Only `Brand.tsx` has genuinely diverged**: 176 lines against 22.

So the problem is not that something drifted. **It is that eleven are duplicated
at all** — ten of them identically, kept in step by nothing but discipline,
which is precisely what `which-surface.md` says the answer is not. Ten identical
copies are ten chances for the eleventh edit to land in one file only.

**`Brand.tsx` is what that looks like after it has happened.** Desktop's carries
GithubMark, GitLabMark, GiteaMark, the `HostMark` lookup and the brand tints;
web's carries GithubMark alone — so **the web client cannot draw a GitLab or a
Gitea mark at all.** A reported design gap in the desktop app turned out to have
a code twin, and it is this file.

Four primitives exist on web with no desktop counterpart and should not be
rebuilt: **Checkbox** (which Skills' multi-select needs), **Menu** (desktop has
`Pop`; two implementations of one idea), **Table**, **QrCode**.

### Patterns matter more than primitives

Reuse is not lost on buttons. It is lost on shapes that recur and get
re-implemented because nothing is obviously wrong with any single screen. Six
are named in the components artifact, rendered as miniatures:

**list page** (eleven configuration screens are this shape; `config/bits.tsx`
already has two thirds of it in `Section` and `Rows`) · **create menu**
(`config/CreateMenu.tsx` exists and is used twice; every other *Add* is a plain
button) · **picker sheet** (seven pickers, one shape, no shared component) ·
**refusal dialog** · **state set** — empty, loading, error, denied, server dark,
all five of which a fresh install hits at once, so none is an edge case ·
**where-this-lives note**.

---

## 6. How to read the artifacts

Both are in `docs/prototypes/redesign/`, self-contained, light by default with
a theme toggle. Beside them: `measure.py`, which produces the usage counts, and
`usage.json`, which is its output and the evidence behind every number in the
component list.

**`desktop-redesign.html`** — fifteen tabs. Ten are mock-ups of a 1280×824
window; five are documents:

* **Every screen** — the contact sheet, and **read this one first**. All 96
  states at a third scale, grouped as Coverage is, each tile a control that
  opens it full size. It exists because a reader looking for the connect screen
  could not find it and reported it missing: it is the eleventh of fifteen tabs
  and they had the document open. **A tab row says where you can go and never
  what is there.** Any artifact with more than a handful of states wants one.

* **Coverage** — every *feature* the app has and whether this design draws it.
  Feature granularity, not component: "Git hosts ✓" was true of an earlier draft
  while only GitHub was drawn. Parent rows carry a tally of their children
  rather than a verdict, so a section cannot read as a tick. Currently **122
  drawn · 4 partly · 28 not yet**, of 154, plus 3 marked *deliberately not
  drawn*, which is a different answer from *no*.
* **Spec** — measurements, type scale, motion, the token derivations, the
  keyboard map, and the code delta. The keyboard section is **two tables**:
  what the app binds today with a file and line for each, and what the redesign
  proposes with what it costs. Keep that split if you extend it; it is the most
  useful distinction in the document.
* **Grouping** — why six destinations, and the alternatives.
* **Notes** — the running argument.

**`components.html`** — forty components and six patterns, rendered live on the
real stylesheet in shadow roots. Ordered by how much the design leans on each.

### The usage counts are measured, and the harness is shipped

"Used on 50 screens" is not a claim. A headless browser walks the redesign
artifact — every tab, every view inside it, every overlay opened over each one —
and records which component appears where. Seven of the forty components are not
yet rendered and say so rather than pretending.

**The harness is `docs/prototypes/redesign/measure.py`.** It was described here
before it was shipped, which meant the next designer rebuilt it; that is the
kind of gap this document exists to close. Run it after changing the redesign
artifact and the component list's numbers regenerate.

Three traps in it, all of which cost a measurement before they were found:

* **Reset global state between screens.** `Threw` latches the error screen, and
  a tab press clears only per-tab state. Once it had been pressed, every later
  screen in the walk *was* the error screen.
* **Click the in-window triggers the masthead cannot reach** — the profile menu
  and the Firetower switcher. Anything added later that only opens by clicking
  inside the window needs the same treatment or it reports as *used once*.
* **Skip the document tabs.** They draw no window, and `render()` leaves `#win`
  holding whatever was last in it — so walking them attributes a stale screen's
  classes to a screen that has none. This was wrong until late: the count
  published at first was **74 screens**, of which 24 were documents measured as
  though they were windows. The true figure is **50**.

---

## 7. What is not done

* **Mobile.** Not started, deliberately. It is a separate effort and this
  document is the handoff to it.
* **The menu-bar island.** Left out on purpose. It has its own HTML entry point,
  its own window, no chrome, and rules that contradict this design on purpose —
  the pill is the black the notch is made of, and ember on it is the one place
  in the product where the colour is decoration rather than a signal. Putting it
  in the same artifact would mean two design systems in one file. It wants its
  own.
* **28 Coverage rows.** Named individually in the artifact. The largest
  clusters: Skills' multi-select and bulk share/delete, the skill detail's
  Bundle / Versions / Defaults tabs, the administrator's *add a host* flow
  (distinct from *connect your account*, which is drawn), per-repository
  environment and setup script, and *paste a remote*.
* **Seven unrendered components** — Window, Panel, Sheet, Veil + Sheet2,
  Inspector, FileTree, and AgentMark. All large composites that need a miniature
  window around them to mean anything.

---

## 8. Bugs found in the shipped app

Found while reading the code this design is based on. None is fixed here —
this work touched no product code — and they are recorded so they are not lost.

| Where | What |
|---|---|
| `ui/Rail.tsx:87`, `:446` | The tooltip advertises **⌘N** for *New workspace*. Nothing in `desktop/src` binds `"n"`. The shortcut does not exist. |
| `ui/Account.tsx:65` | The must-replace-password banner uses `border-ember-deep bg-ember-tint`. Ember means an agent is waiting on you; this is a second meaning. |
| `desktop/STYLE.md:51,56,105` | Claims a 34px list row three times. The shipped row is 32px. See §3. |
| `ui/Palette.tsx` | Exists and is **unreferenced** — `grep -rln "Palette" desktop/src` returns only the file itself. Nothing imports it, nothing renders it, no key opens it. The redesign wires it up for the first time, which makes it new work rather than a restyle. |
| `justfile — check-style` | Greps `web/app web/components web/src mobile/app mobile/src` but not `desktop/src`. Three arbitrary values this design needed would have been caught by it. |
| `fleet.ts:49` · `mobile/src/ui/ServerChip.tsx:28` · `mobile/app/(tabs)/you.tsx:67` | All three derive a Firetower's monogram as `org.slice(0, 1)`. Acme and Apex both render "A"; Northwind and Nimbus both render "N". One de-duplicating derivation, used in three places. |

One collision to resolve when the palette is wired: **⌘K is already taken** —
`ui/Shell.tsx:105` clears the terminal. The resolution follows a precedent the
code already sets at `Workbench.tsx:345`, where the window handler defers to the
terminal for everything except ⌘J: **inside the terminal ⌘K clears; everywhere
else it opens the palette.** `Shell.tsx`'s own comment anticipates this, for a
palette that was never wired up.

---

## 9. The backend does not have to change

Checked, because it changes how this work is estimated: **none of this design
needs a server change.** Three findings worth carrying.

**Artifact posters already exist.** `/api/v1/artifact-versions/{id}/poster`,
with `posterUrl` and `hasPoster` as two separate fields on the model. The
schema's own note says why they are two rather than one optional URL: the client
has to tell *no picture taken* from *no picture possible*, "and only the first
of those is worth queueing". The four poster states in §1 are drawable today.

**Bulk skill actions are a client gap, not a server one.** `ShareSkills` and
`SkillIds` are already plural. Skills' multi-select — one of the open Coverage
rows — is UI work only.

**Light mode is `globals.css` and nothing else.** No endpoint, no stored
preference, no migration. Which also means the cost of *not* doing it is
nothing, and the cost of doing it is bounded.

---

## 10. The working method

Three habits, all of which were learned the expensive way. They are worth
inheriting.

**Render it and look at it.** Not "read the code back" — screenshot the page and
read the screenshot. Every real bug in this work was found that way and none was
found by re-reading source. A headless render takes seconds:

```
chrome --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=1400,1600 \
  --virtual-time-budget=5000 --screenshot=out.png file.html
```

**A class-collision audit.** Five collisions shipped before the audit was right.
The ones that hurt were not two unscoped rules fighting — they were a class
defined *unscoped* in one sheet and used as somebody's *descendant* in another,
where the unscoped rule leaks every property the scoped one does not set. A
poster inherited a page wrapper's padding and became invisible; an annotation
card leaked `position:absolute` into a section heading; a run-step's
`flex-direction` stopped a progress bar from rendering at all.

The reverse case is worse and only the live DOM can catch it: a class defined
*only* as somebody's descendant, used under a different parent, renders
completely unstyled while the stylesheet stays valid.

**A control sweep.** Drive every control in the page and report anything that
throws. `GITHUB` was undefined for several rounds, which meant three
configuration panes threw a `ReferenceError` *before rendering* — the screen
simply did not change and nothing said why. Reading the file would never have
found it; one sweep did.

A last note on checks themselves. The first version of the specimen check asked
whether a rendered component had height. Every specimen was rendering the
literal string `undefined`, which has height, and the check passed. **A check
that cannot fail is worse than no check**, because it is also an assurance.

**Rules do not transfer; pictures do.** The mobile work's first draft satisfied
every sentence in this document and looked like the old app — it carried a
repository and a branch under every row, a four-colour glyph on each one, a
chevron at the end and a segmented filter above the list, every one of which is
named here or in `STYLE.md` as a thing to remove. It was drawn from reading the
rules rather than from looking at the screens they produce. What fixed it was
rendering `docs/prototypes/redesign/` at 2× and counting what is actually in one
row. It is four things, and two of them are optional.

So: **read this document, then look at the artifacts.** The habit at the top of
this section applies to reading a handoff as much as to checking your own work.

### One practical note

The three skills the brief for this work names — `firetower-surfaces`,
`apple-design`, `frontend-design` — are not in this repository. Both designers
on this work started without them and recovered them separately. If a brief
names a skill, check it is reachable before concluding a predecessor ignored it.
