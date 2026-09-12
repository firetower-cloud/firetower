# Firetower on macOS — style guideline

The token system lives in `web/app/globals.css` and is enforced by `just check-style`.
Nothing here redefines it. This covers what the tokens cannot: density, native
surfaces, and the two things a multi-server client has to express that a
single-server web app never did.

## The rule everything else serves

**Ember is the only loud thing on screen.** It answers one question — is something
waiting on you — and it stops answering it the moment it answers anything else.
Every decision below is downstream of protecting that.

## Colour is fully spent

Three namespaces already exist and there is no room for a fourth:

| namespace | what it means | where |
|---|---|---|
| signals | ember, sage, brick, slate | state, anywhere |
| file kinds | nine categories, deliberately desaturated | the tree, and nowhere else |
| ground | six surfaces, neutral by design | everything |

So anything new is identified by **shape, weight, or position** — never by a new hue.

### Servers are marks, not colours

A monogram in `--color-dim` → `--color-bone`, on `--color-raise`. Selected state is
a bar and a brightness step, not a tint. See `.server-mark`.

This is the single most load-bearing decision in the native client: with N servers
the temptation to colour-code them is constant, and taking it would put a second
loud thing next to ember.

### Reachability is dimmed, never red

`brick` means something failed. A server behind a VPN that is off has not failed —
it is not there. Unreachable is a dashed border, `--color-mute`, no shadow. Its
rows stay visible at 45% with saturation pulled back (`.stale`).

Rows from a dark server **do not disappear**. A list that empties itself when the
network drops reads as work being lost.

## Density

The web build carries a 44px floor on anything tappable below `md`. The Mac app is
mouse-only and tighter:

| | web | mac |
|---|---|---|
| list row | 44px | **34px** (`.row`) |
| chrome row | 48px | **38px** (`--chrome-title`) |
| tab / control | 36px | **28px** |
| status strip | — | **22px** |

34px is the measurement the whole inbox is built on. Change it and re-check the
tree, the palette and the tab strip together.

## Native chrome

- **Title bar spans the window.** Traffic lights need 78px (`--chrome-lights`) and
  the server strip is 48px, so reserving the gutter inside the strip pushes the
  overlap one column right instead of solving it. One full-width bar, everything
  below it starts at a clean edge.
- **Drag regions.** `.drag` on chrome, `.no-drag` on every control inside it. A
  control in a drag region that forgets this becomes furniture you cannot click.
- **Vibrancy.** `--color-panel-vibrant` and `--color-strip` are the same values as
  their opaque tokens at reduced alpha, over `NSVisualEffectMaterial::Sidebar`.
  The web build never sees them and stays opaque.

## Motion

`--dur-native: 140ms` on `--ease-swift`, where the web build uses 200ms. Native is
quicker; the curve is the same.

`ember-pulse` is unchanged. It is the one thing allowed to be slow, because it is
the one thing meant to catch your eye from across the room.

## Type

Archivo, Archivo Narrow, JetBrains Mono — unchanged. The system face would be more
native and less Firetower, and the six-size scale is deliberate. Not relitigated
here.

`.eyebrow` is the instrument-panel voice: narrow, 10.5px, 0.18em, uppercase, mute.
Use it for section labels and nothing else.

## Where the rules live

- Tokens and components: `web/app/globals.css`
- The native layer: `desktop/src/styles.css`
- Rendered, with every state: run the app and open `#/style`

The style page is also the prototype's remote — drop a server, fire an ember,
stall a request — because these states are otherwise only reachable by waiting.

## What this client shares with the web build

Patterns and vocabulary, not layout.

**Shared, and resolved out of `../web` rather than copied:** `group()` for
repositories and workspaces, `doing()` for what a place is up to, `Signal`,
`AgentMark`, `elapsed()`, the `ui/` primitives, every token.

**Not shared:** the screens. A window gets 34px rows, a title bar that is part
of the app, ⌘-numbered tabs and no drawer.

Two rules fall out of the shared half and are worth stating, because both were
violated on the first pass:

- **`Icon` takes 12, 14, 16 or 20.** Not 11, not 13. The scale is deliberate and
  the type enforces it.
- **A workspace row is two lines:** name, ember dot and elapsed on the first;
  branch in mono and the agent marks on the second. The branch is not optional
  decoration — it is how you tell two workspaces on one repository apart.


---

# Making it read as a Mac app, not a web page

Six things account for almost all of the difference. They are listed in the
order they pay off.

## 1. Reading gets its own size

The web scale is tuned for a phone that has to fit a workbench into 390px. The
thing people do here longest is read a conversation, so reading is sized for
prose and the chrome around it stays small:

| | value | where |
|---|---|---|
| `--text-lede` | 17px / 1.5 | the question an agent is asking |
| `--text-read` | **15px / 1.7** | the conversation |
| `--text-ui` | 13.5px | controls, rows, labels |
| `--text-meta` | 12px | secondary facts |
| `--text-micro` | 11px | counts, keycaps |
| `--text-code` | 13px / 1.65 | diffs, paths, branches |

Raising everything uniformly just makes a dense screen bigger. What works is
*widening the gap* between what you read and what you operate.

## 2. Rows and controls get room

`--row: 40px`, `--row-tight: 32px`, `--control: 30px`. One control height
everywhere, so a toolbar reads as a row of instruments rather than as whatever
each control happened to need.

## 3. Selection fills; it does not mark an edge

A sidebar row on this platform is a **full-width rounded rect that fills**
(`.row[data-on]` → `--color-overlay` plus the raise shadow). The 2px coloured
bar in the left margin is a web convention and is the single clearest tell.

## 4. Segmented controls are recessed, not flat

`.track` is an inset track with a raised knob — the platform's shape. Two flat
buttons that swap colour is a web tab bar wearing a different hat.

## 5. The window says what it can do

`.keycap` renders a shortcut inline, next to the thing it operates: `⏎ send`,
`⇧⏎ new line`, `⌘\` on the inspector, `⌘1`–`⌘3` on its tabs, `⌘J` on the
terminal. Desk software tells you its shortcuts where you use them. A web app
hides them in a help page.

## 6. Code scrolls; it never wraps

A line broken mid-identifier is harder to read than one you scroll to. Every
diff and every path is `whitespace-pre` inside its own `overflow-x-auto`.

---

## The chat surface

- **One column, ~46rem.** Under 80 characters at 15px.
- **The agent speaks onto the ground.** No container, no avatar, no bubble — its
  turn is long and it is the thing you came to read. **You** get a raised card,
  right-aligned. Two facing bubbles is a messaging app; this is not one.
- **Tool calls hang off a hairline** to the left of the text, so a turn that
  touched fourteen files still reads as one paragraph with work attached.
- **Thinking is collapsed** to a single line. It is context, not the answer.
- **The composer is the second-heaviest object on the screen** — rounded 2xl,
  floating shadow, attachments as chips, model and mode as menus that open
  upward, and a context meter that answers *am I near the edge* with a shape
  rather than a token count.

## What the boldness is spent on

One thing: **an agent is waiting on you.** It gets the ember, the pulse, the
only saturated surface in the window, and a `--text-lede` question. Everything
else on screen is built to stay quiet so that this reads from across the room.

Nothing else may use ember. Not a badge, not a hover, not a chart.

## Three habits to avoid

These are what make a generated interface look generated, and the first draft of
this client did all three:

- **An ALL-CAPS eyebrow above every heading.** `.eyebrow` is the map-legend
  voice — column headers and section legends. It is not a decoration to put
  above every title.
- **Meta strings joined with middle dots** (`repo · branch · 4m`). Use real
  layout: separate spans, honest spacing, or a labelled row.
- **A rounded card around everything.** One radius on every object flattens the
  hierarchy it was supposed to express. The conversation has no card; the
  composer does.


---

# Files

## Syntax is the one allowed exception to "colour is spent"

A fourth namespace, `--color-syn-*`, and it earns the exception for one reason:
**it never appears outside a file or a diff.** It cannot compete with the
signals at the page level because it is never on the page level.

| | | |
|---|---|---|
| comment | `#6a6a74` | below everything; it is the thing you skip |
| string | `#8fb99a` | |
| keyword | `#9a8cc4` | |
| type | `#7d95b0` | |
| number | `#c2ab63` | |
| fn | `#b8845f` | |
| attr | `#8a8a94` | |

All of it sits below the signals in saturation, for the same reason the file
kinds do: four hundred lines of code must not out-shout the one thing on screen
that means an agent is waiting on you.

The highlighter is ordered regexes, not a parser. A parser is right for an
editor and wrong for a viewer — what a reader needs is for strings, comments and
keywords to stop looking like identifiers.

## Tabs behave like an editor's

- **The conversation is pinned first and cannot be closed.** It is what a
  workspace *is*, and a strip you can empty is one you can get lost in.
- **Single click previews** — the tab opens in italic and the next preview
  replaces it. Skimming six files while reading a diff should leave one tab, not
  six. **Double click keeps it.**
- The active tab is marked **along its top edge**, where an editor marks it.
- A tab's dot takes the file-kind colour the tree already uses.

## The gutter carries the diff

A line this session wrote gets a sage number cell and a tinted row, so "what did
it change in here" is answered without leaving for the diff. The count in the
header is clamped to the file — a header reading "33 lines, 40 touched" is the
kind of small lie that makes a reader stop trusting the rest of the screen.

## Selecting code starts a note

A quote and the line it began on, pinned, then sent back as an ordinary message.
The same shape the conversation's annotations use, so a note against a file and
a note against a message go back the same way.

## Ways into a file

Four, because wanting the file under discussion is the commonest thing anybody
does here: the tree, the diff list's open-file control, a `read` in the
transcript, and `⌘P`.
