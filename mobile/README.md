# Firetower on a phone

The third client. `docs/mobile.md` is the plan and the reasoning; this is how
to run it.

## What it is

React Native on the New Architecture, through Expo. Not a webview: every list,
gesture and keyboard transition is native. The screens are this client's own —
a phone is not a small Mac — but the *vocabulary* is shared, because there is
one control plane and it has one idea of what a workspace is doing.

## Running it

```sh
just mobile-android     # builds a dev client, installs it, starts Metro
just mobile-ios         # the same, on a simulator
just mobile             # Metro alone, for a client already installed
```

The first build of each platform compiles the native project and takes a few
minutes; after that it is Metro and Fast Refresh.

Needs Node 22, pnpm, and then per platform: Xcode plus CocoaPods for iOS, a JDK
and the Android SDK for Android. `just doctor` says which of those are missing.

### Pointing it at a control plane

Anything the phone can reach. For one running on the same machine as the
emulator:

```sh
adb reverse tcp:4400 tcp:4400     # then connect to  localhost:4400
```

An iOS simulator shares the Mac's network, so `localhost:4400` works with no
forwarding. A real device wants the machine's address on your network, or a
Tailscale name.

## The shape of it

| | |
|---|---|
| `app/` | the screens, as routes — `expo-router` |
| `src/api/` | the generated client, and the folds shared with the other two |
| `src/ui/` | the components |
| `src/design/` | tokens, **generated** from `web/app/globals.css` |
| `src/native/` | the registry, and the Keychain |

### The tokens are generated, not copied

`scripts/tokens.mjs` reads the `@theme` block out of `web/app/globals.css` and
writes the Tailwind config NativeWind compiles against, plus the raw values for
the places a class name cannot reach — a Reanimated worklet, the status bar, an
SVG fill. Run by `just gen`, checked by `just gen-check`.

So a colour that exists here and not in `globals.css` is a build failure rather
than a review comment, and `just check-style` covers `mobile/` the same way it
covers `web/`.

### What is shared with the desktop, and why

`view.ts`, `workspaces.ts`, `conversation.ts`, `steps.ts`, `ship.ts`,
`patch.ts`, `syntax.ts`, `frames.ts`, `issues.ts` — and their tests, which is
most of the point. They are pure functions over the contract, and three clients
that decide separately what a workspace is *doing* will eventually disagree in
front of somebody.

Copied rather than resolved out of a package, for now, the way `desktop/` copies
from `web/`. If they drift, extract the package then.

### What React Native made different

Four things, each written down where it happens:

- **`socket.tsx`** closes on the way to the background and reopens on the way
  back, resuming every subscription from its own cursor. A socket the OS killed
  still reports `OPEN`.
- **`probe.ts`** has no "answered but refused the app" state. That exists on the
  desktop because a webview's pages have an origin; React Native's `fetch` sends
  none, so `CLIENT_ORIGINS` in `ft-server` needs no entry for the phone.
- **`text.ts`** points `Image` at the file with an auth header instead of
  fetching bytes into a blob URL.
- **`app.config.ts`** allows cleartext and local-network addresses on purpose.
  A great many installs are `http://192.168.1.40:4400`.

## Tests

```sh
pnpm test        # the folds, in node — 82 of them, ported with the code
pnpm tsc --noEmit
```

`vitest.config.ts` stubs `react-native` and the two native storage modules.
Nothing under test touches them; they only have to resolve.
