# Firetower on a phone

A plan for `mobile/`, the third client. It is a plan, not a specification:
the numbers at the end are estimates and the decisions in the middle are the
ones worth arguing about before anybody writes code.

## What this is

The desktop client answers *is something waiting on me, and can I deal with it*
at a desk. The phone answers the first half from anywhere and enough of the
second half that you do not have to go back to the desk to unblock an agent.
That is the whole product thesis of Firetower — an agent that stops is only
expensive if nobody is there — and the phone is the only client that can be
there.

So the phone is **not a small desktop**. It ships the path from *an agent is
waiting* to *the agent is unblocked*, and it ships reading the work that came
out of it. It does not ship administering a fleet.

**In v1**

- Connect to one or many control planes, one current at a time, the way Slack
  does workspaces.
- The inbox: every workspace on the current server, grouped by repository,
  filtered by what it is doing.
- Tasks and trackers, and starting a workspace from one.
- Starting a workspace from nothing.
- Connecting a repository — picked from what the control plane's git token can
  already see. See *The one administrative screen* below.
- The conversation: read it, answer it, approve what it asks, interrupt it.
- The repository: the diff, the file tree, a file, and shipping it — commit,
  push, open the pull request.
- Push notifications, so the app does not have to be open to do its one job.

**Deliberately not in v1**

- Hosts, secrets, users, agent accounts, organisation, updates. Administering a
  fleet is a desk job and both other clients do it.
- The preview tab and port forwards. A forwarded port opens in the system
  browser instead; an embedded webview of a dev server on a phone is a
  worse browser.

### The one administrative screen

Repositories were on the list above for a while, and being strict about it was
wrong in exactly one place: the new-workspace form asks for a repository, and
this client had no way to produce one. A repository approved on the desktop
showed up here immediately; a repository nobody had connected yet could not be
added at all, so the answer to *start work on that* was *go and find a laptop*.
That is the one thing the phone exists not to be.

So there is a **Config** tab — the desk's `Configuration` page, at the width a
phone has and with almost all of it left behind — and `/repos` behind it. It is
deliberately the narrow half of the desktop's configuration page:

- **It lists what the git token can already see.** The control plane holds this
  person's GitHub token, and `/providers/{id}/repos` is what it can clone.
  Connecting one is `POST /repos` with a slug and a remote off that list.
- **Nothing is authorized here, and no device flow runs on the phone.** A code
  to type into a browser on another device, entered from the device that *is*
  the browser, is the worst place to run that flow, and the desktop already runs
  it well. A phone whose account has never been authorized says so, and says
  where it is done.
- **No settings, no env, no removal.** A setup script and a file of secrets are
  a desk job; this screen is the step that stands between somebody and starting
  work, and nothing more.

It is a fourth tab rather than a section of `You`, and that is the part worth
arguing with. `You` is **this phone's**: which Firetowers it knows about, which
one is current, who you are on each. Config is **one server's**, the same for
everybody signed into it, and different the moment you switch. Putting a
server's repositories under the list of servers puts a thing and the things
inside it at the same level, and a section legend is not enough to say which is
which. The organisation sits under the title instead, because the answer to
*whose configuration is this* changes on the tab next door.

Pasting a remote by hand — the desktop's other half — is not here either. It is
not a device flow and would not be wrong to add; it is a URL typed on a phone
keyboard, which is the worst way to enter one, and the picker covers everybody
whose repositories are on a host they have authorized.

**Kept, but scheduled last** — the terminal and code annotations were not cut,
and they should not be built before the six things above work. A tmux pane
behind a software keyboard and a selection-anchored popover are both real
design problems, and neither is on the path from *waiting* to *unblocked*.
They are Phase 6.

## Where it lives

`mobile/`, beside `desktop/` and `web/`, in this repository.

Three clients in one tree is already the shape: the contract in
`api/openapi.json` is generated once from the Rust and consumed three times,
and `just gen-check` is what stops any of them drifting. A separate repository
would mean a published contract, a version skew nobody notices until a phone
in somebody's pocket 400s, and a second place to fix the same bug.

It gets its own release-please package — a third entry beside `.` and
`desktop` in `release-please-config.json`, component `mobile`, tags
`mobile-v*` — because a phone build is cut when the phone is ready, and
coupling it to the control plane's version means shipping an App Store build
to change a Rust log line.

```
mobile/
  app/                 Expo Router — the screens, as routes
  src/
    api/               generated client + the folds (conversation, steps, ship…)
    ui/                the components
    design/            tokens, generated from web/app/globals.css
    native/            keychain, registry, notifications, deep links
  STYLE.md             the phone's half of the style guide
  app.config.ts
  tailwind.config.js
  package.json
```

## The stack, and why

| | | |
|---|---|---|
| **React Native** | New Architecture, Fabric, Hermes | Not a webview. Every list, every gesture and every keyboard transition is native. |
| **Expo (SDK, prebuild) + EAS Build** | chosen | Real React Native — Expo is a toolchain, not a runtime. EAS owns signing, TestFlight submission and Android distribution, which is the part of this that is otherwise two weeks of fastlane. |
| **expo-updates (OTA)** | on | The reason this matters is below, under distribution: a TestFlight build expires in 90 days and a JS-only fix otherwise costs a Beta App Review. |
| **Expo Router** | file-based | It is React Navigation underneath, and it gives typed deep links for free — which push notifications need and which a hand-rolled linking config gets wrong. |
| **NativeWind** | chosen | Keeps the Tailwind vocabulary, so a screen here reads like the screen it came from and `just check-style` extends to this directory with one more path. See the version note below. |
| **react-native-reanimated** + **gesture-handler** | v4 / v2 | Everything animated runs on the UI thread. `Animated` from core does not, and the difference is visible on the exact interaction people judge the app by — the keyboard. |
| **react-native-keyboard-controller** | required | The single most load-bearing dependency in this plan. Its own section below. |
| **@shopify/flash-list** | v2 | The transcript is long, heterogeneous and grows at the bottom. |
| **react-native-mmkv** | registry | `servers()` is read synchronously all over the client. AsyncStorage is not synchronous; MMKV is. |
| **expo-secure-store** | tokens | Keychain on iOS, Keystore on Android. The exact analogue of `bridge.secrets`. |
| **orval** | shared | The same generator and the same contract, a third output target. |

**A note on NativeWind's version, to be resolved in week one.** NativeWind v4
targets Tailwind 3.4 and the web build is on Tailwind 4, so the token layer has
to be generated either way (below). If v5 is stable by the time we start, it
reads Tailwind 4's `@theme` blocks directly and the generator collapses to an
import. Spike it on day one and take whichever is stable — the rest of the plan
does not change, only the size of `design/`.

**What we are not using, and why it comes up**

- `react-markdown`, `remark-gfm` as rendered on desktop — the parse is portable,
  the renderer is DOM. See *The transcript*, below.
- `@xterm/xterm` — there is no terminal in v1, and when there is, it is not
  xterm.
- Any WebView. The constraint was stated and it is also correct: a webview
  loses the keyboard, the scroll physics and the back gesture, which is
  three-quarters of what "native" means to somebody holding the thing.

## What crosses over, and what does not

This is the part worth getting right, because it decides how much of the phone
is new code.

**Portable as-is.** These files are pure functions over the contract's types
with no DOM in them. They are the vocabulary the desktop's own STYLE.md says
the clients must share, and re-deriving them on a third client is how three
clients start disagreeing about what a workspace is *doing*.

| file | what it is |
|---|---|
| `api/view.ts` | `NEEDS_YOU`, `elapsed()`, `minutesSince()`, what a status means |
| `api/workspaces.ts` | `group()`, `doing()`, `shortRepo()` |
| `api/conversation.ts` | the fold from lifecycle events into drawable items — 791 lines, the single biggest saving |
| `api/steps.ts` | runs of scaffolding folding into one row |
| `api/ship.ts` | uncommitted → unpushed → pushed → open, and the button's label |
| `api/issues.ts` | issue references and the trailer |
| `api/frames.ts` | which listener a frame belongs to, resubscribe backoff |
| `api/text.ts`, `patch.ts`, `syntax.ts` | is-it-an-image, unified diffs, the ordered-regex highlighter |

`api/socket.tsx` is *nearly* portable — React Native has a `WebSocket` — but it
needs a lifecycle it has never had (below), so it is ported rather than copied,
and the parts that are decisions rather than effects are already split out into
`frames.ts`.

How to share it is a real choice and the cheap answer is right for now:
**copy, with `just gen` regenerating the generated half and a test suite on
both sides.** The desktop already copied from web rather than resolving across
the workspace, `pnpm` workspaces across three apps with three different
bundlers is a day of nobody's time well spent, and a `shared/` package can be
extracted later from files that are already identical. What must not happen is
the phone growing its own idea of what `doing()` returns. If the copies drift,
extract the package then.

**Not portable, and not worth pretending otherwise.** Every screen. A window
gets 34px rows, a title bar and ⌘-numbered tabs; a phone gets a 44pt floor, a
bottom tab bar and a back gesture. The desktop client already wrote this rule
down about the web client and it applies again with the sign flipped.

## The design system on a phone

The tokens are the contract, and they have one home: `web/app/globals.css`.
Nothing is redefined here and no hex value is typed into a `.tsx` file in
`mobile/` — which is what `just check-style` already enforces for `web/`, and
what it will enforce for `mobile/` with one more path in the grep.

**The token pipeline.** A generator parses the `@theme` block in
`web/app/globals.css` into two outputs:

- `mobile/src/design/tokens.generated.js` — consumed by `tailwind.config.js`,
  so `bg-raise` and `text-dim` mean the same thing here as there.
- `mobile/src/design/tokens.generated.ts` — the raw values, for the places
  that cannot go through a class name: Reanimated worklets, the status bar,
  the Android navigation bar, the notification accent colour, the splash
  screen.

It runs in `just gen` beside orval, and `just gen-check` fails on a stale
commit exactly as it does for the API client. A colour that exists in the app
and not in `globals.css` is a build failure, not a review comment.

**What changes, and what does not.** Three things are constitutional and cross
unchanged:

- **Ember is the only loud thing.** It answers one question. On a phone it
  gets three new surfaces to be loud on — the app icon badge, the notification,
  and the inbox row — and it gets nothing else. Not a tab bar tint, not a
  pull-to-refresh spinner, not the send button.
- **Colour is fully spent.** Servers are monograms, not hues, and the argument
  for that is *stronger* here: a phone shows one server at a time, so a colour
  code would be a legend you can never see.
- **Unreachable is dimmed, never red.** A server behind a VPN that is off has
  not failed, and on a phone it is off constantly — walking out of the office
  is not an error state. Rows from a dark server stay visible at 45%.

Three things invert, and they are the whole of "feel mobile":

- **Density goes back up.** The desktop took the web's 44px touch floor down
  to 34px because a Mac is mouse-only. A phone takes it back: **44pt minimum on
  anything tappable**, `--row` at 56pt for an inbox row that carries two lines
  and a mark. The desktop's table becomes a list of cards; nothing is a table.
- **The reading size is the web's, not the desk's.** `--text-read` at 15px was
  chosen for a 46rem column on a monitor. A 390pt phone gets 16px prose at 1.6,
  because the column is narrow and the distance is shorter. `--text-input` — the
  16px floor that exists so iOS Safari does not zoom — is a web problem and
  does not exist in React Native; drop it here rather than carry a token that
  means nothing.
- **Shortcuts become gestures.** `.keycap` is desk furniture. Its job — *the
  app tells you what it can do, where you do it* — survives as swipe actions on
  a row, long-press menus, and a visible drag handle on anything draggable.
  Nothing is discoverable only by guessing.

**Motion.** `--dur-native: 140ms` is the desk's number because a mouse is
quick. A phone's own curves are slower and platform-specific, and fighting them
is the first thing that reads as a web app: screen transitions, sheet detents
and the keyboard use the platform's timing, and only in-content motion — a
disclosure opening, a chip appearing — uses our own tokens. `ember-pulse` is
unchanged and remains the one slow thing.

**Type.** Archivo, Archivo Narrow, JetBrains Mono, unchanged. The files in
`desktop/src/fonts` are `.woff2` and useless here; the TTFs come from
`@expo-google-fonts/archivo` and `@expo-google-fonts/jetbrains_mono`, both OFL,
loaded through `expo-font` with the splash held until they are ready so nothing
renders in the system face and reflows.

**`mobile/STYLE.md`** is written alongside the first screens and is the sibling
of `desktop/STYLE.md`: it covers density, the navigation model, the keyboard,
and the gestures, and it redefines no token. It gets the same escape hatch the
desktop has — a `/style` route, in development builds only, that renders every
state including the ones you can otherwise only reach by waiting.

## The screens

### The navigation model

Three bottom tabs and a stack. No drawer.

- **Inbox** — every workspace on the current server, grouped by repository,
  with the desktop Dashboard's own filter as a segmented control: All ·
  Waiting · Working · Idle. This is one screen doing the job the desktop
  splits between the Rail and the Dashboard, because a phone has room for one.
- **Tasks** — trackers, one at a time, as `/tasks` answers them.
- **You** — the account on this server, the server switcher, notification
  settings, sign out, about. Not administration.

The current server is a monogram in the header, always. Tapping it opens a
sheet listing every connected server with its reachability and its waiting
count; picking one swaps the whole tab stack. That is Slack's model, it is the
model the desktop's `scope` already implements, and it is the answer to
*connect to one or many, not necessarily at the same time*.

A workspace pushes onto the stack. The back gesture works, always, including
out of a file and out of the sheet — a screen that traps you is the other
three-quarters of what "not native" means.

### Connecting

`desktop/src/probe.ts` ports directly, including the two-questions-in-order
shape: **where is it**, then **who are you there**. `GET /bootstrap` is
unauthenticated and names the organisation before anybody types a password,
which is the whole reason it is asked first, and on a phone — where typing an
address is worse — it matters more.

Three things are new and one of them will bite.

- **`MIN_SERVER` gets its own floor for this client.** The desktop's 0.34.1 is
  about CORS headers, which do not apply here. The phone's floor is whatever
  version first carries the push-registration endpoint; below it the app
  connects and says notifications need a newer control plane rather than
  failing silently.
- **CORS does not apply.** React Native's `fetch` and `WebSocket` send no
  `Origin` and enforce no same-origin policy, so `CLIENT_ORIGINS` in
  `ft-server` needs no new entry. Worth writing down because it is the first
  thing everyone will ask.
- **Cleartext and local addresses will bite.** A great many Firetower installs
  are `http://192.168.1.40:4400`, a `.local` name, or a Tailscale address. iOS
  App Transport Security blocks cleartext HTTP by default and Android has since
  API 28; iOS additionally requires the local-network permission for anything
  on the LAN, and the prompt is *not* raised by `fetch` — it is raised by
  Bonjour, so an app that only makes HTTP calls gets a silent failure instead
  of a dialog. This needs, on purpose and written down in the store listing:
  `NSAllowsLocalNetworking` plus `NSLocalNetworkUsageDescription`, a
  `network_security_config.xml` permitting cleartext, and a connect screen that
  says *this address is not encrypted* rather than one that fails. **Plan a day
  for this and test it on a real device on a real LAN in Phase 1**, not in
  Phase 6 — it is the single most likely thing to make the first build look
  broken to the first ten people who try it.

Tokens go to `expo-secure-store`, keyed by `serverId` exactly as the desktop
keys the keychain — the same server on a new address is the same server. The
registry goes to MMKV. Neither is ever written to a plain file.

### The inbox

`group()` and `doing()` do the work; the row is the desktop's two-line
workspace row at touch density — name, ember dot and elapsed on the first line;
branch in mono and the agent marks on the second. The branch is not decoration
and it is not dropped for width: two workspaces on one repository are otherwise
indistinguishable, which on a phone is worse than on a monitor.

Pull to refresh, because it is the gesture people will make whether or not the
socket makes it unnecessary. Swipe a row for its two destructive-ish actions —
rename, end — behind a confirm. A long press gets the rest of the desktop's
context menu.

The "+" is the new-workspace form, which is a form and translates without
argument, except that the repository and branch pickers become sheets and the
prompt field is the composer from the conversation screen, reused.

### Tasks

`/tasks` answers for one tracker per request and the two page differently —
GitHub by number with a total, Linear by cursor with none — so the desktop
shows one at a time and the phone does the same. The chips and the search box
are query parameters the source reads in its own dialect; they are sent, never
applied locally, for the reason the desktop file already gives: filtering the
answer again is how rows go missing.

Which tracker is a mark, not a word, and on 390pt that stops being an
aesthetic choice.

Tapping a task starts a workspace seeded from it — the one thing this screen
is for.

### The conversation

This is the screen. Everything else is how you get to it.

The fold is `api/conversation.ts`, unchanged, and it earns its place: it already
turns lifecycle events into a list of complete things, which is exactly the
shape a `FlashList` wants. What is new is rendering and the keyboard.

**The list.** `FlashList` v2, not inverted. Inverted lists on Android have
never been right — the scrollbar, the overscroll and the keyboard inset all
invert with them — and the correct primitive now exists:
`maintainVisibleContentPosition`, so the list holds its position when items
arrive above the viewport and follows the bottom when you are already at it.
Two behaviours to get right because everybody notices when they are wrong:

- Streaming text appends to the last item. If you are at the bottom you stay
  pinned; if you have scrolled up to read something, **you do not get yanked**,
  and a "jump to latest" pill appears instead.
- A new turn arriving while you are reading does the same.

**The transcript's voices**, from the desktop, and correct here for the same
reasons:

- The agent speaks onto the ground. No bubble, no avatar. Its turn is long and
  it is what you came to read.
- You get a raised card, right-aligned. Two facing bubbles is a messaging app
  and this is not one.
- Tool calls hang off a hairline to the left, so a turn that touched fourteen
  files is one paragraph with work attached.
- Thinking collapses to one line.
- Runs of three or more commands, reads or searches fold into one disclosure
  and an edit never folds, because the edit is the work. That is `steps.ts`,
  ported.

**Markdown.** `react-markdown` is DOM and does not port. The renderer is
replaced, the *parse* should not be: `remark-parse` and `remark-gfm` already
ship in the desktop, and if they run under Hermes — a half-day spike in Phase 2,
before anything is built on it — the phone parses to the same mdast and walks it
into `<Text>` and `<View>`. If they do not, the fallback is `marked` in its
lexer-only mode, which is smaller and older and will. This is more work than picking
`react-native-markdown-display` off the shelf and it is the right call — it
keeps the two clients agreeing about what a nested list, a table or a fenced
block *is*, and it keeps raw HTML off, which is the reason the desktop renders
markdown through one file rather than at each call site. Budget three days.

**Code, in the transcript and in a file.** `syntax.ts` is ordered regexes and
ports untouched; it emits spans and the phone renders them as nested `<Text>`.
The desktop's rule holds without modification: **code scrolls, it never wraps.**
A line broken mid-identifier is harder to read on a phone than on a monitor,
not easier. Each block is a horizontal `ScrollView`; when there is a gutter,
the line numbers are a fixed column beside it and only the code moves.

**Approvals are the one loud thing.** When the agent is blocked, the card is
the most saturated surface on the screen, it carries the question at lede size,
and its two buttons are 48pt and far enough apart that neither is hit by
accident — the agent is genuinely stopped while it is up, the tool call is held
open on the host, and this can sit there for hours. A haptic on arrival. The
same card is what a push notification opens to.

### The composer

The explicit requirement, and the thing an app is judged on in the first ten
seconds. It gets its own budget.

`react-native-keyboard-controller` is not optional. React Native's own
`KeyboardAvoidingView` animates on the JS thread against a guessed duration and
a guessed height, and the result is the composer arriving a frame or four after
the keyboard — which is precisely the tell. The library reads the keyboard's
frame every frame on the UI thread and exposes it to Reanimated worklets, so:

- The composer is a `KeyboardStickyView`, pinned to the keyboard's actual top
  edge, moving **with** it rather than after it. No jump, no settle, no gap on
  a device with a home indicator.
- The list's bottom inset is driven from the same worklet, so the message you
  were reading does not slide under the keyboard as it opens.
- `keyboardDismissMode="interactive"` — drag down on the transcript and the
  keyboard follows your finger and can be dragged back. This is the single
  gesture that makes a chat app feel like iMessage rather than like a form.

The rest of the behaviour, spelled out because "the input must shrink the right
way" is a specification:

- **Growth.** One line at rest. Grows with content to six lines, then scrolls
  internally. The grow is animated on the UI thread and the list's inset
  follows it in the same frame.
- **Collapse.** Scrolling the transcript down collapses the composer's
  furniture — the attachment chips row, the model and mode pickers — to a
  single line with a "+" and the send button. Scrolling up, or focusing,
  restores it. The message you are typing is never hidden and never cleared.
- **Send.** `⏎` inserts a newline; send is the button. The desktop's `⏎ send /
  ⇧⏎ new line` is a hardware-keyboard convention and inverting it on a phone
  loses half the messages people write. (With a hardware keyboard attached —
  iPad, a Mac-adjacent setup — `⌘⏎` sends.)
- **Attachments.** The web and desktop rule is the contract and does not
  change: **pictures go inside the message**, because the model looks at them;
  **every other file goes into the workspace with `attach_file`** and is only
  named in the message, because the agent has its own tools for reading one and
  sending the bytes twice is waste. On a phone this means the camera roll and
  the camera go one way and the document picker goes the other, and the chip
  appears the moment you pick, before the upload finishes, carrying its own id
  — the desktop learned that removing one by index is wrong exactly when the
  batch is mixed.
- **Pickers.** Model and mode are bottom sheets, drawn from
  `session_controls` — what the agent reports it can change, never a list kept
  in the client, so a Codex session is never offered Opus. The optimistic
  `remember` behaviour ports: choosing shows as chosen, and the server's answer
  corrects it.
- **The context meter** stays a shape, not a token count, and moves to the
  composer's top edge as a hairline that fills.
- **Interrupt.** While the agent works, send becomes stop. It is the same
  button in the same place, because reaching for a different one while
  something is running is the wrong time to make somebody aim.
- **Drafts survive.** `workspace/draft.ts` ports; a draft survives
  backgrounding, a server switch and a cold start.

### The repository — tabs, diff, files, ship

The desktop puts the conversation in the middle and the repository in a rail
you keep open or push away, on the argument that reviewing a diff must not hide
the conversation explaining it. On a phone there is no beside. The translation
that keeps the argument is a **bottom sheet with detents**:

- **Peek** — a bar above the composer: *12 files, +340 −88*, and the shipping
  stage. Always visible in a workspace that has changes. This is the rail.
- **Half** — the three tabs the desktop's Inspector has: **Diff**, **Files**,
  **Commit**. The conversation is still on screen above it.
- **Full** — the sheet takes the screen, and opening a file from here pushes a
  file viewer onto the stack, so the back gesture is the way out.

The desktop's tab strip survives, in the file viewer, as a horizontally
scrolling strip with the **conversation pinned first and uncloseable** —
tapping it pops back. The preview convention survives too: a single tap opens
in italic and is replaced by the next preview; long-press keeps it. Skimming
six files while reading a diff should leave one tab, on any screen size.

The diff reads `session_diff` and renders through `patch.ts`. The gutter
carries the diff exactly as on the desktop — a line this session wrote gets a
sage number cell and a tinted row — and the count in the header is clamped to
the file, because "33 lines, 40 touched" is the kind of small lie that makes
somebody stop trusting the screen.

**Commit** runs the sequence `api/ship.ts` describes and `Ship.tsx` draws:
`describe_session` proposes a title and body, they are a draft to edit rather
than a box to fill, and the button commits the kept files, pushes, and opens
the pull request with its issue trailer. `shipping()` reduces every checkout to
one stage and one honest button label; that logic ports and the screen is
rewritten around a single full-width 48pt action, since the desktop's
three-controls-in-a-row does not fit and should not be squeezed.

## The network, on a phone

One socket per **current** server. The others hold nothing: no socket, no
poll, no timer. This is the difference between the desktop's fan-out across
every backend and what a phone can afford, and it is why the multi-server model
is Slack's rather than the desktop's fleet view — a unified inbox across four
self-hosted servers means four sockets and four radio wakeups on cellular, for
a question push notifications answer better and for free.

The socket itself is `api/socket.tsx` with a lifecycle it has never needed:

- **Background.** iOS suspends the process; the socket dies and there is no
  arguing with it. On `AppState` leaving `active`, close cleanly and remember
  every subscription's cursor.
- **Foreground.** Reopen and resubscribe **from the cursors**, which is what
  the `from` field on `Sub` is for and what makes a reconnect replay nothing
  and lose nothing. The existing per-subscription cursor design is exactly
  right for this and is the reason it works out of the box.
- **A cold start from a notification** goes straight to the workspace and
  subscribes to that conversation before the inbox has loaded. The transcript
  is what you tapped for.
- **Connectivity.** `expo-network` gates reconnection, so a phone in a tunnel
  backs off instead of retrying into a dead radio. The existing `nextResume`
  backoff handles the rest.

Queries keep their per-server `QueryClient`, `refetchInterval: false`, and the
stream as the source of freshness — that whole argument ports unchanged. What
is added is `refetchOnReconnect` and a refetch on foreground, because a phone
is disconnected far more often than a Mac and the cache is staler when it
comes back.

## Push notifications

The app's job is to be the thing that tells you. Without push, you have to
remember to open it, and if you remember to open it you did not need it.

### The server already has the seam

`crates/ft-server/src/notify.rs` is a `Notifier` with one method that matters —
`stopped(session, name, about, url)` — fired from `fleet.rs` when a session
stops and needs somebody. Its own doc comment says the shape is right and that
a real sender becomes a second sender rather than a rewrite. That is what this
is.

The work:

1. **A device table.** `migrations/server/<ts>_devices.sql`: device id, user id,
   platform, the APNs/FCM token, a public key (below), created and last-seen.
   Per user, per server — each control plane is separate and knows only its own
   users.
2. **`POST /api/v1/devices` and `DELETE /api/v1/devices/{id}`**, added to the
   contract, generated into all three clients by `just gen`.
3. **A `Sender` trait**, with the existing webhook as one implementation and the
   relay as the other. `FIRETOWER_NOTIFY_URL` keeps working exactly as it does
   today, for everybody who already has it pointed at ntfy or Pushover.
4. **Fan-out**: `stopped()` resolves the session's owner to that user's devices
   and sends one payload each.

### The relay, and the thing that has to be said out loud

A self-hosted control plane **cannot** talk to APNs on behalf of the Firetower
app. The APNs key belongs to the app's Apple team, there is one of it, and
shipping it to every install would let any install push to every user. This is
not a Firetower problem; it is true of every self-hosted app with an iOS
client, and every one of them solves it the same way — a relay.

So: **an opt-in relay, run by us, that cannot read the notification.**

- At registration the device generates a keypair, keeps the private half in the
  Secure Enclave / Keystore, and hands the public half to the control plane
  along with a delivery token minted by the relay.
- The control plane encrypts the title and body to that public key and POSTs
  `{ deliveryToken, ciphertext }` to the relay. The relay sees a token and a
  blob. It does not see the session name, the organisation, the repository, or
  the server's address.
- The relay forwards to APNs as a `mutable-content` push and to FCM as a data
  message. On iOS a Notification Service Extension decrypts and rewrites the
  body before it is shown; on Android the message is built on device.
- Opt-in per server, off by default, and the setting says plainly what leaves
  the machine: *a delivery token and an encrypted blob, to push.usefiretower.com*.
  Anybody who will not accept that keeps the webhook.

This keeps the README's claim honest — the control plane never exposes itself,
the worker still never dials out, and the relay learns nothing — at the cost of
an NSE and a small always-up service. Both are worth it, and both should be
built in Phase 4 with the payload shape frozen first, because the payload is
what the contract commits to.

**The payload** carries `serverId`, `sessionId`, the session's name and the
note — the fields `Waiting` already has. `notify.rs` names the session rather
than its id for exactly this reason: a notification on a phone has to say which
of four agents wants something before anybody will open it.

**The deep link** is `firetower://servers/<serverId>/sessions/<sessionId>`,
routed by Expo Router, and it switches the current server on the way. A
notification from a server you are not currently on must still work; that is
most of the point.

**The badge** is set from the push payload's count, so the icon is right
without the app running — which is the one thing the desktop's dock badge gets
from a poll and the phone cannot.

## The harness

Everything the desktop has, with `mobile` in front of it.

**`just`**

```
just mobile            # expo start, dev client
just mobile-ios        # run on a simulator
just mobile-android
just mobile-test       # tsc --noEmit, vitest, eslint
just mobile-build      # eas build --profile preview, both platforms
just gen               # extended: orval for mobile, + the token generator
just gen-check         # extended: fails on a stale client or stale tokens
just check-style       # extended: mobile/ joins web/ in the grep
just doctor            # extended: node, pnpm, eas-cli, xcode, java
```

**`.github/workflows/mobile.yml`** — on every pull request touching `mobile/**`
or `api/openapi.json`, mirroring `desktop.yml`: install, `tsc --noEmit`,
`vitest`, `eslint`, and then **`eas build --profile preview`** for both
platforms, with the artifacts on the run so a branch can be installed before
it is merged. No secrets on the PR job, so a fork is safe — the same rule
`desktop.yml` follows, and the reason preview builds use an internal
distribution profile rather than a signing one.

**`.github/workflows/mobile-release.yml`** — called by `release.yml` when
release-please cuts a `mobile-v*` tag, or run by hand for an existing tag.
Runs in the protected `release` environment:

- `eas build --profile production --platform all`
- `eas submit --platform ios` → TestFlight
- The signed `.aab` to Play's internal track, and the signed `.apk` uploaded to
  the GitHub Release beside the `.dmg` — that is the Android channel that needs
  no review at all.
- `eas update --branch production` for OTA, on a JS-only change.

**Tests.** The same three tiers the desktop has, plus one it does not:

- `vitest` over the ported logic — `conversation`, `steps`, `ship`, `frames`,
  `issues`, `patch`, `syntax`, `tabs`. These are already tested on the desktop
  and the tests port with the code. This is the majority of the suite and it
  runs in seconds.
- `@testing-library/react-native` on the components that have states worth
  asserting: the approval card, the composer's grow and collapse, the ship
  button's label at each stage.
- **Maestro** for the two flows that are only real end to end on a device:
  connect → sign in → see the inbox, and open a workspace → answer → see it
  arrive. Run on the release workflow, not on every PR.
- `/style` in development builds, as the desktop has it, for the states you
  otherwise reach only by waiting.

**Contract drift** is the one failure that would be invisible: a phone in
somebody's pocket against a newer server. `gen-check` covers the build, and the
connect screen's `MIN_SERVER` covers the runtime — the app says *this server is
newer than this app* rather than failing a request.

## Distribution

**Android, from day one, with no review.** A signed APK on the GitHub Release
beside the desktop installers, and a download link on the site. That is the
whole thing. A Play internal-testing track in parallel because it is free and
it gets the update mechanism working, but the APK is the channel.

**iOS, in three steps.**

1. **Internal TestFlight, immediately.** Up to 100 App Store Connect team
   members, 30 devices each, **no review** — a build is live minutes after
   processing. This is the team and the design partners, and it is available in
   week one. The Apple team, the certificates and the notarisation key already
   exist for the desktop, which removes most of the setup.
2. **Public TestFlight link, after Beta App Review.** A public URL anybody can
   join, up to 10,000 testers. It needs Beta App Review on the first build of
   each version train — lighter than App Review, typically about a day. You
   have a demo control plane for the reviewer, which is the thing that usually
   blocks this: an app that needs a server the reviewer does not have gets
   rejected as unevaluable, and the fix is an address and credentials in the
   review notes. **Confirm before submitting that the demo install is
   reachable from outside, is on a current version, and has a workspace with a
   finished diff and an agent waiting** — a reviewer opening an empty app
   rejects it.
3. **The App Store, submitted in parallel rather than after.** Two reasons, and
   the second is the one people forget. A TestFlight build **expires after 90
   days**, so the public link is a channel with a rolling deadline, not a
   destination. And Apple's own position is that TestFlight is for beta
   testing; using it as a permanent distribution channel works until somebody
   at Apple decides it does not.

**OTA is what makes the 90 days survivable.** `expo-updates` ships a JS-only
fix — a crash, a layout bug, a copy change — without a build, without a review
and without resetting the expiry clock. Native changes still need a build.
Set a policy now and write it in `mobile/README.md`: OTA for fixes, builds for
features, and every OTA update is behind the same `main`-merged commit as a
build would be.

**What the store listing has to say**, drafted early because it shapes the
first-run screen: Firetower needs a control plane you run; the app connects to
addresses you type; local and unencrypted addresses are supported on purpose
and the app says so; notifications are opt-in and what leaves the device when
they are on.

## Risks

**The keyboard.** It is the requirement and it is the thing most likely to be
merely adequate. Mitigated by making it Phase 2's acceptance criterion rather
than Phase 6's polish: interactive dismissal, sub-frame stickiness, and grow
without inset lag, on a real iPhone and a real mid-range Android, before the
phase closes.

**Local and cleartext addresses.** Covered above. The risk is not that it is
hard; it is that it is discovered late, by users, as "the app cannot see my
server".

**Three copies of the fold.** `conversation.ts` is 791 lines of the product's
actual meaning and it will exist in three directories. Mitigated by the test
suite porting with it and by a standing instruction: a change to a shared file
lands in all three, in one commit, or it is extracted to a package.

**The relay is a new service to run.** Small, but it is the first thing
Firetower operates on behalf of installs. Mitigated by the encryption — losing
it leaks nothing but delivery tokens — and by keeping the webhook as the
escape hatch for anybody who will not use it.

**Markdown and diff rendering are bigger than they look.** Both are "just
rendering" and both are a week. Budgeted as such rather than discovered.

**The terminal, if it is built.** A tmux pane on a software keyboard is not a
small problem: `xterm` does not port, the alternatives are thin, and the
keyboard has no Ctrl. It is Phase 6 and it should be allowed to slip.

## Phases

Estimates assume one experienced React Native engineer full-time, with backend
help for Phase 4. They are ranges because the two unknowns — the markdown
renderer and the keyboard on Android — are genuinely unknown until someone is
inside them.

**Phase 0 — the pipeline, before the app (3–5 days).** Scaffold `mobile/`. The
token generator and `tailwind.config.js`. `just` recipes and both workflows.
Then the thing that matters: **get a screen that says "Firetower" onto a real
iPhone through TestFlight and onto a real Android through a GitHub Release.**
Distribution is the part that surprises people, and it is worth surprising them
in week one against a blank screen.

**Phase 1 — connect and the inbox (1.5–2 weeks).** Probe, sign-in, the server
registry, secure storage, the server switcher. The socket with its
foreground/background lifecycle. The inbox, grouped and filtered. Cleartext and
local-network addresses tested on a real LAN. At the end of this phase the app
answers *is something waiting on me*, which is already most of its value.

**Phase 2 — the conversation (2.5–3 weeks).** The transcript, the markdown
renderer, the folds, the approval card, and the composer. The phase does not
close until the keyboard is right on both platforms.

**Phase 3 — the repository (1.5–2 weeks).** The sheet, the diff, the tree, the
file viewer with its tab strip, and shipping.

**Phase 4 — push (1.5–2 weeks, overlappable).** Migration, endpoints, the
`Sender` trait, the relay, the NSE, the deep link, the badge. Backend and app
in parallel once the payload is frozen. Can start during Phase 2 — nothing in
it depends on the conversation screen existing.

**Phase 5 — tasks, and starting work (3–5 days).** Trackers, the task list,
seeding a workspace, and the new-workspace form.

**Phase 6 — polish and the channels (1.5–2 weeks).** `mobile/STYLE.md` and the
`/style` route. Maestro flows. Accessibility: Dynamic Type, VoiceOver and
TalkBack on the inbox and the approval card, reduced motion. Empty and error
states. Beta App Review and the public link. App Store submission. The
terminal and annotations if there is room, and they are allowed not to fit.

**Roughly 11–14 weeks to a public TestFlight link and an Android APK**, with an
internal build in week one and something genuinely useful — the inbox — in week
three.
