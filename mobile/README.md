# Firetower on a phone

The third client. `docs/mobile.md` is the plan and the reasoning; this is how
to run it.

## What it is

React Native on the New Architecture, through Expo. Not a webview: every list,
gesture and keyboard transition is native. The screens are this client's own —
a phone is not a small Mac — but the *vocabulary* is shared, because there is
one control plane and it has one idea of what a workspace is doing.

`STYLE.md` is the design guideline — density, motion, the composer, and the
handful of places where being a phone changes the answer rather than the size.
It redefines no token; `desktop/STYLE.md` is its sibling and should be read
first.

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

## iOS, the first time

Xcode 26 ships without the iOS platform, and CocoaPods is still the integration
point on this SDK — `expo prebuild` generates a `Podfile`, not a
`Package.swift`. React Native core itself arrives as a prebuilt XCFramework
(`RCT_USE_PREBUILT_RNCORE`), which is why the first build is minutes rather
than half an hour.

```sh
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
xcodebuild -downloadPlatform iOS        # ~8.5 GB, the simulator runtime
```

If `pod install` dies with `certificate verify failed (unable to get local
issuer certificate)`, Homebrew's Ruby cannot find a CA bundle. Point it at the
system one:

```sh
SSL_CERT_FILE=/etc/ssl/cert.pem pod install
```

## Putting it on somebody's phone

`eas.json` has three profiles, and the difference between them is **who can
install the result**. The file itself carries no comments — the schema rejects
them, including `//` keys — so the explanation is here.

| profile | what it is for |
|---|---|
| `development` | a dev client: Metro drives it and Fast Refresh works. How the app is worked on. |
| `preview` | standalone, JS bundled, installable from a link. What goes to somebody who wants to try it — no App Store, no review, only that their device is registered. |
| `production` | the store build. TestFlight for iOS, an `.aab` for Play; see `docs/mobile.md` on why TestFlight is a bridge and not a destination. |

```sh
npx eas-cli@24 login
npx eas-cli@24 device:create   # a link they open on the phone; registers the UDID
npx eas-cli@24 build --profile preview --platform ios
```

**`eas-cli` is deliberately not a dependency of this project.** It is a tool,
not something the app builds against, and having it in `devDependencies` drags
`dtrace-provider` into the lockfile — a native module needing node-gyp, which
fails on EAS's builder during "Install dependencies" with an error that says
nothing about where it came from. `cli.version` in `eas.json` pins the version
instead, which is what EAS itself suggests.

Android needs none of that: `--platform android` gives an APK anybody can
sideload.

## Tests

```sh
pnpm test        # the folds, in node — 82 of them, ported with the code
pnpm tsc --noEmit
```

`vitest.config.ts` stubs `react-native` and the two native storage modules.
Nothing under test touches them; they only have to resolve.

### End to end, on a simulator

```sh
maestro --device <udid> test e2e/connect.yaml \
  -e ADDRESS=192.168.1.40:4400 -e USER=admin -e PASS=…
maestro --device <udid> test e2e/answer.yaml
```

Two flows, and they are deliberately the only two: connecting, and writing to
an agent. Both cross the network, the keychain and the socket, which is
exactly what a unit test would have to pretend about — everything else in
`pnpm test` is a pure function over the contract precisely so that these can
stay small.

`maestro` picks the first device it finds, which on a machine with an Android
emulator running is the wrong one. Pass `--device` with the simulator's UDID
from `xcrun simctl list devices`.

These need a booted simulator, so they are not in the pull-request workflow.
