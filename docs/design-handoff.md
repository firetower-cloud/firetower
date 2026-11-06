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

### Light is the design; dark follows from it

This is the biggest departure from the app as it stands, which is dark-only.
Designing in dark and deriving light produces a light theme that looks like a
dark theme with the lights on — the contrast relationships are built around a
dark ground and do not invert. Designing in light and deriving dark produces
both honestly, because light is the harder constraint: there is less room above
white than below black.

### An artifact preview is a poster, never a live frame

Non-negotiable, and the reason is security rather than taste. An artifact is
untrusted HTML. In an unsandboxed iframe it is same-origin with the app, which
puts the Tauri bridge within reach of it. It is also six page loads, six
runtimes and six sets of timers for a grid of six. So previews are static
images, and the four degraded states — has one, not yet, not possible, failed —
are drawn properly rather than left to a broken-image glyph.

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

### The derivation method

Each light value is the dark value with **L\* lowered or raised while a\* and
b\* are held**, so the hue and its chroma direction survive, until it clears a
stated floor. Which floor depends on what the colour is measured *against* —
and that is the part worth copying, because it is where the first attempt went
wrong.

* **File kinds and chart series** are measured against the page. The floor is
  whatever the dark set's own weakest member clears on `#111113`: **5.7:1** for
  a kind, **4.8:1** for a series.
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

**Amber needed a second step, and it is the one token this work adds.**
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

One more that will come up: in the ember namespace `-soft` is mostly the *text
on the tint*, which is the reverse of that split. Both are consistent on what
matters — **`-soft` is the lighter of the pair in either theme** — and the roles
swap because text on a dark tint has to be lighter while text on a pale tint has
to be darker. Ember has only ever been dark, so the question has not arisen for
it. **When ember is re-gated for light it will need the same split.**

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

Both are in `docs/prototypes/redesign/`, self-contained, light by default with a
theme toggle.

**`desktop-redesign.html`** — fourteen tabs. Ten are mock-ups of a 1280×824
window; four are documents:

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

### The usage counts are measured

"Used on 74 screens" is not a claim. A headless browser walks the redesign
artifact — every tab, every view inside it, every overlay opened over each one —
and records which component appears where. Seven of the forty are not yet
rendered and say so rather than pretending.

To re-run it after changing the redesign artifact: the harness drives the
masthead controls, resets all global state between screens (a latched error
screen silently poisoned every later measurement the first time), and clicks the
two in-window triggers the masthead cannot reach — the profile menu and the
Firetower switcher. Anything added later that only opens by clicking inside the
window needs the same treatment or it will report as *used once* when it is not.

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
| `justfile — check-style` | Greps `web/` and `mobile/` but not `desktop/src`. Three arbitrary values this design needed would have been caught by it. |

One collision to resolve when the palette is wired: **⌘K is already taken** —
`ui/Shell.tsx:105` clears the terminal. The resolution follows a precedent the
code already sets at `Workbench.tsx:345`, where the window handler defers to the
terminal for everything except ⌘J: **inside the terminal ⌘K clears; everywhere
else it opens the palette.** `Shell.tsx`'s own comment anticipates this, for a
palette that was never wired up.

---

## 9. The working method

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
