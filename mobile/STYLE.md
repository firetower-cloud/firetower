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
- **The padding gives way as the box grows.** Roomier at rest, tighter once
  you are writing in it. The card getting taller while its padding shrinks is
  most of what the morph actually *feels* like, and both ride the same
  `LinearTransition` on the UI thread.
- **It draws back at rest and comes forward to write.** A wider inset when
  idle, edge-to-edge when open. That is most of why the morph reads as the box
  *stepping toward you* rather than merely growing, and it costs nothing — it
  rides the same shared value as the corner radius.
- **The composer's edge is lit from above.** The desk does this with
  `--shadow-raise`'s `inset 0 1px 0 rgb(255 255 255 / 0.04)`. React Native has
  no inset shadow, and per-side border colours say the same thing in one
  hairline: `--color-line` on top, `--color-line-soft` around the rest. The box
  reads as raised rather than as a rectangle of a slightly different grey, and
  it needs no gradient and no new native module to do it.
- **Which pickers exist is the session's business, not ours.** They come from
  `session_controls`: a Codex session offers different ones from a Claude
  session, and an agent that has not said yet offers none. A hard-coded row is
  a picture of a control — and for a while that is exactly what these were,
  `Pressable`s with no `onPress`. The row scrolls, because four pickers do not
  fit beside a `+`, a microphone and a send button.
- **`grave` survives the trip.** The contract marks the choices that change
  what an agent may do unsupervised and asks for them to be drawn apart. A
  list where "ask me first" and "never ask me again" look identical is the one
  place in a picker where getting it wrong costs something.
- **A dictation is not one result.** A continuous recogniser closes a segment,
  sends it with `isFinal`, then starts numbering again from empty. Assigning
  `results[0]` each time looks right for two sentences and then throws the
  whole utterance away. Finished segments accumulate; only the unfinished one
  is ever replaced.
- **A control that does not know stays quiet.** The model picker is absent
  until the agent says what it is running. "Opus 5" under a session running
  something else is a lie the picker tells until somebody speaks.
- **Controls are 40pt circles and the box has 8pt of air.** The desk's density
  is a mouse pointer's density. A phone's chrome has to be hittable without
  aiming and legible at arm's length, and the difference between a composer
  that feels like an app and one that feels like a form is almost entirely
  this — a few points of padding and a few points of radius, everywhere.
- **The composer sits on the keyboard, not on the home indicator.** The bottom
  inset is the home indicator's, and the keyboard covers the home indicator.
  Holding that 34pt open once the keyboard is up leaves a band of nothing
  between the box and the keys, which is the single clearest tell that a
  layout was written for a browser.
- **The composer sizes itself; nothing measures it.** A `TextInput` that
  measures its own content and feeds the answer back into its own height
  deadlocks: once the field has an explicit height, iOS reports *that height*
  as its `contentSize`, so the measurement can never exceed the box and the
  event stops firing. The box stays two lines and everything past that scrolls
  out of sight. `minHeight` and `maxHeight` do the same job with no feedback
  loop in them, and the platform animates the growth better than we did.
  Whatever owns `flex` must not be the thing whose height is in question.
- **Dictating shows a wave.** A microphone button with no feedback is
  indistinguishable from one that is broken: you talk, nothing moves, and you
  stop to check. The wave is a *trail*, not a meter — the newest sample enters
  at the right and the history slides left, so a pause leaves a visible gap
  behind it and you can see the shape of what you just said. Real amplitude,
  on the UI thread, in one shared value.
- **Menus grow out of the thing you pressed.** `transformOrigin` pins the
  scale to the `+` button's corner. A panel that fades in centred on nothing
  is a div; a panel that expands from under your thumb is a menu.
- **A panel that opens has to close by tapping away from it.** The scrim
  reaches up over the conversation. A control you can only dismiss by finding
  the same small button again is one people get stuck in.
- **Say the surprising half only.** "Camera / Photos / Files" needs one line
  of explanation and it is on *Files*, because a file going into the workspace
  rather than into the message is the only thing there you could not guess.

## Waiting is a thing to say, not a thing to spin

Every screen had an `ActivityIndicator` in `--color-mute` and every one read
as a hang. One component now, because the reasons were the same everywhere.

- **An empty state is a claim, and a claim needs something to have come back.**
  "Nothing has been said yet." sat on top of conversations that were merely
  large, and "Nothing is waiting on you" was printed before the first response
  arrived. An empty transcript means two different things — nobody has spoken,
  or the snapshot is still crossing the wire — and a screen cannot tell them
  apart without being told. That is what `Conversation.arrived` is for.
- **Say what is being fetched.** A spinner names neither the thing nor whose
  fault it is if it never comes.
- **Use `Sheen`, not a spinner.** It is already this app's way of saying *this
  is not finished yet*, it sweeps per glyph so it is visibly alive, and its own
  docblock is the argument: a spinner on something that may take four minutes
  reads as a hang.
- **Nothing for the first 350ms.** A fast load that flashes a spinner is its
  own kind of broken.
- **No second caption.** It grew a "Still going." line after six seconds, on
  the theory that it answered *is this stuck*. The sweep already answers that,
  continuously — and a caption that appears on its own is a small alarm going
  off. Removed.
- **Centre a screen, left-align a row.** A screen waiting for its whole
  contents centres, because the wait *is* the screen. Something opening inside
  a list does not: a folder expanding belongs to the row above it, and a
  centred word floating over a file tree reads as a different and larger thing
  happening.
- **One sentence, and no skeleton.** It drew the transcript's shape in
  placeholder bars for about a day. A skeleton promises a specific layout is
  about to appear in a specific place, and next to one sweeping line that says
  exactly what is happening it was scaffolding around a sentence that did the
  job alone.

One thing to know if you write another `Sheen`-like effect: a component that
renders one `Text` per character is a row of one-letter labels to anything
walking the tree. Carry the whole string on the group and hide the pieces.

## The socket carries what happens next, never a backlog

A phone closes its socket every time it goes to the background and reopens it
from each subscription's cursor. The desk never does that, and a phone
backgrounds constantly — a screenshot, the app switcher, the lock button.

So a stream is a fine way to hear what happens *next* and a bad way to catch
up on ninety thousand lines: each foreground restarts a replay that is
interrupted again before it lands, and because the fold advances its cursor as
those lines arrive, a transcript can stop somewhere in the middle and stay
there. That is what it did, and it is why the desk never saw it.

**Catch up over HTTP, always.** One request with `sinceLine` either arrives
whole or not at all, and a failure leaves the cursor where it was. It is tiny
when there is nothing to catch up on, which is almost always.

Any long backlog on a mobile client wants a request, not a stream.

## A cached transcript has to be re-readable

`start` skips the snapshot whenever `lastLine > 0`, and `lastLine` comes from
the *log's* end rather than from what actually folded. So a conversation that
ended up holding less than the server sent still claims to be up to date: it
resumes from the end for the rest of the process, never asks for the middle
again, and no amount of leaving the screen and coming back changes it.

Pull down on a transcript to read it again from nothing. Emptying first is the
mechanism, not a side effect — putting `lastLine` back to 0 is the only thing
that makes `start` choose a snapshot over a resume.

Any cache whose staleness cannot be detected from inside needs a way to be
told from outside.

## The type scale is the desk's, spoken louder

Every size moves up roughly a sixth from `globals.css`, and the small end
moves most. This is one override in `scripts/tokens.mjs`, not a second scale.

It is worth knowing how it got here, because the mistake is easy to repeat:
when the file tree and the diff still read as small, the scale went up a
second time — and the scale was not what was wrong with them. They were
carrying their own hardcoded sizes and reading no token at all. The sans came
back down a point afterwards; the mono stayed. *Check what a screen actually
reads before moving the thing it is supposed to read.*

The web's sizes exist to fit a workbench into a browser window: `--text-body`
is 14px so a three-pane desk survives at 1280px, and `--text-micro` is 10.5px
because a column header beside a mouse pointer can afford to be tiny. None of
those pressures exist on a phone, and the opposite one does — one column, held
at arm's length, often in one hand and in motion.

**iOS sets body text at 17pt and Android at 16sp.** An app that comes in three
points under the platform does not read as denser. It reads as *smaller*,
which is the thing a reader notices before they notice anything else you did.

What does not change is the number of voices: six sizes and a mono, exactly as
on the desk. Line heights are unitless ratios in `globals.css`, so the leading
follows on its own and the rhythm survives.

The cost is real and worth saying: at `--text-code` 15px a phone holds about
five fewer characters per line than the desk's 13px, so code scrolls sooner.
That is the right trade for a screen whose job is reading.

**A scale only reaches what reads it.** The file tree and the diff carried
their own hardcoded sizes — `fontSize: 11.5` for code, `fontSize: 10` for the
gutter — so the first phone-wide bump went up *around* the two screens made
entirely of text and left them exactly as small as they were. `check-style`
greps for inline `fontSize:` now, because a literal in a `style` prop is the
same offence as `text-[11.5px]` and was the one with nothing watching it.

**A bigger scale finds every row that was one word from colliding.** Label-and
-hint pairs, counts beside titles, anything laid out with `justify-between` and
no `shrink` — the fix is to say which half gives way, and it is never the one
you have to read.

## Code, diffs and files

Unchanged from the desk, and *more* true at this width:

- **Code scrolls; it never wraps.** A line broken mid-identifier is harder to
  read on a phone, not easier — and *both halves of that are a feature*. For
  a long time only the second was implemented: `numberOfLines={1}` kept each
  line whole and nothing carried it sideways, so the rest of it was laid out
  and then clipped, unreachable. A rule that says "scrolls" is not satisfied
  by a rule that only says "does not wrap".
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
