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
