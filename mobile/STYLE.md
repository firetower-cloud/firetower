# Firetower on a phone — style guideline

The token system lives in `web/app/globals.css` and reaches here through
`scripts/tokens.mjs`. Nothing below redefines it. This covers what the tokens
cannot: density, what replaces the chrome a window has, and the two or three
places where being a phone changes the answer rather than the size.

Read `desktop/STYLE.md` first. Most of it still applies, and where this
disagrees it says so and why.

## The rule everything else serves

**Ember is the only loud thing on screen.** It answers one question — is
something waiting on you — and it stops answering it the moment it answers
anything else.

A phone gives it three surfaces a window does not have: the app icon badge, the
notification, and the inbox row. It gets those and nothing else. Not the tab
bar, not the send button, not a pull-to-refresh spinner.

**Ember means blocked, not "on the list".** `needsYou` groups `NeedsYou`,
`HandedBack` and `Failed`, because all three want a human — that is the right
grouping for a count. It is the wrong grouping for a colour: finished, blocked
and broken are three different things to feel. The row tint is keyed to
`NeedsYou` alone; a failure is brick and a hand-back is sage.

## Density inverts

The desk took the web's 44px touch floor *down* to 34px because a Mac is
mouse-only. A phone takes it back:

| | web | mac | phone |
|---|---|---|---|
| list row | 44px | 34px | **56pt**, two lines and a glyph |
| control | 36px | 28px | **44pt** minimum, anything tappable |
| primary action | — | 30px | **52pt**, full width |

Nothing is a table. The desk's dashboard is a list of rows here, and the
inbox is the rail and the dashboard at once, because there is room for one.

## Reading gets its own size, again

The desk widened the gap between what you *read* and what you *operate* by
raising reading to 15px for a 46rem column. A phone does the same move in the
same direction: `--text-read` is **16px/1.6**, and everything else keeps the
token it had.

One size, not a seventh voice. `--text-input` — the 16px floor that exists so
iOS Safari does not zoom a focused field — is a web problem and does not exist
here.

## What replaces the chrome

A window has a title bar, a server strip, a rail and ⌘-numbered tabs. A phone
has a stack and a back gesture.

- **Three tabs**: Inbox, Tasks, You. The inbox carries the dashboard's own
  filter, because that is the vocabulary.
- **The server is a monogram in the header**, always, and tapping it switches.
  Slack's model. Still never a colour — with N servers the temptation to
  colour-code is constant, and on a phone it would be a legend you can never
  see, since only one server is ever on screen.
- **The repository is a page, not a rail.** This is the one place the desk's
  layout argument does not survive the trip. "Reviewing a diff must not hide
  the conversation" is right on a monitor; as a sheet over a 390pt screen it
  left three lines of conversation — which is not context — and squeezed the
  diff into a third of the screen. A strip above the composer says what
  changed; tapping it opens a page that has room. One gesture away is what
  "next to" means here.

## Motion

**The platform's timing for anything the platform owns**: screen transitions,
sheets, and the keyboard. Fighting those is the first thing that reads as a web
page.

**Our tokens for anything inside the content**: a disclosure opening, a chip
appearing, the composer's morph — `--ease-swift` at 200ms.

**Everything animated runs on the UI thread.** Reanimated worklets, not
`Animated` from core. The difference is only visible on the interaction people
judge the app by, which is exactly why it matters.

`Blocks` — the island's turning glyph — is what an inbox row uses, because the
inbox is the glanceable surface here the way the island is on a desk. Working
turns, blocked breathes, done and broken are perfectly still. Movement means
work is happening, which is why the state that is stuck is the one that does
not move, however loud it is.

## The composer is two shapes

**At rest, a pill.** One row, inset from both edges, holding the placeholder
and the one control that matters. It is furniture; the conversation is the
screen and the composer should not take a sixth of it to say nothing.

**Focused, a card.** The text gets a line of its own, the controls drop to a
second row, corners square off from 26 to 20, and it widens toward the edges.
The desk says *the composer is the second-heaviest object on the screen* — it
is only the second-heaviest while you are writing in it, which is also the only
time it gets the floating shadow.

The morph is one layout transition; the `TextInput` holds the same slot in the
tree throughout, so focus and selection never notice.

**Three ways out**, because a card you cannot put away is a trap: sending,
blurring, and dragging it down. The drag is the one people reach for without
being told, and it keeps whatever is in the box — a draft truncated into the
pill is still there when you tap it.

Rules that are not negotiable:

- **It moves with the keyboard, not after it.** And so does everything else
  that must stay visible — the transcript's bottom inset and the approval card
  ride the same shared value in the same frame.
- **`⏎` is a newline; the button sends.** `⏎ send` is a hardware-keyboard
  convention and inverting it on a phone loses half the messages people write.
  `⌘⏎` sends when a hardware keyboard is attached.
- **Send becomes stop while the agent works** — same button, same place.
- **The send control is whatever comes next.** Empty, it is the microphone —
  saying something is the alternative to typing it, not an extra control
  competing for the same corner. With words in it, send. While the agent
  works, stop.
- **Dictation is on-device.** Firetower's whole architecture is that nothing
  leaves machines you own; a composer that shipped audio to a transcription
  service to reach an agent running on your own hardware would be the one
  place that stopped being true.
- **Pictures go inside the message; everything else goes into the workspace.**
  The model looks at a screenshot, so it travels with the turn. The agent has
  its own tools for reading a file, so sending the bytes twice is waste — it
  is attached and then only *named*.
- **A control that does not know stays quiet.** The model picker is absent
  until the agent says what it is running. "Opus 5" under a session running
  something else is a lie the picker tells until somebody speaks.

## Code, diffs and files

Unchanged from the desk, and *more* true at this width:

- **Code scrolls; it never wraps.** A line broken mid-identifier is harder to
  read on a phone, not easier.
- **The gutter is pinned** while the code moves under it. A horizontal scroll
  that carries the line numbers away throws out the one column that says where
  you are.
- **The count is clamped to the file.** "33 lines, 40 touched" is the kind of
  small lie that makes a reader stop trusting the rest of the screen — and it
  happens the moment the lines and the touched set are counted in two passes.
- **The tab strip keeps the conversation pinned first**, uncloseable, and a
  single tap still previews in italic.

## Gestures replace keycaps

`.keycap` is desk furniture. Its job — *the app tells you what it can do, where
you do it* — survives as swipe actions on a row, long-press menus, and a
visible handle on anything draggable. Nothing is discoverable only by guessing.

## Three habits to avoid

The desk's list, and all three are still live:

- **An ALL-CAPS eyebrow above every heading.** `.eyebrow` is the map-legend
  voice — section legends and column headers. On a phone there is room for
  roughly one per screen.
- **Meta strings joined with middle dots.** Use real layout.
- **A rounded card around everything.** One radius on every object flattens the
  hierarchy it was meant to express. The conversation has no card; the composer
  does, and only while you are in it.
