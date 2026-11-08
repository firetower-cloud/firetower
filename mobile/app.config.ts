import type { ExpoConfig } from "expo/config";

import pkg from "./package.json";

/**
 * The phone's shell.
 *
 * Three things here are not defaults and are load-bearing:
 *
 * - **The system's theme, light or dark.** This was `"dark"`, with a comment
 *   saying so, because `globals.css` had no light values to fall back to and a
 *   phone that respected the system theme would have rendered half a design
 *   system. PR #261 added the light branch; `src/design/phone.css` adds the
 *   phone's own corrections to it. So the stated reason is spent, and the
 *   comment goes with the code. The in-app control on **You** overrides this
 *   per person; `"automatic"` is what makes System mean anything.
 * - **Unlocked orientation.** This was `"portrait"`, which is one line that
 *   made the whole brief unreachable: no window is ever 840 wide in portrait,
 *   so the `dock` band could not be entered on any device. The Duo's inner
 *   landscape pose at 951 is the pose the design is about.
 * - **Cleartext and local addresses are allowed on purpose.** A great many
 *   Firetower installs are `http://192.168.1.40:4400`, a `.local` name, or a
 *   Tailscale address. iOS blocks cleartext by default and additionally gates
 *   the local network behind a permission whose prompt is raised by Bonjour
 *   rather than by `fetch` — so an app that only makes HTTP calls fails
 *   silently instead of asking. Both platforms are told, and the connect
 *   screen says when an address is not encrypted.
 */
const config: ExpoConfig = {
  name: "Firetower",
  slug: "firetower",
  /* release-please bumps package.json; the build number is EAS's. */
  version: pkg.version,
  /* Unlocked rather than portrait. See the note above: portrait alone makes
     the dock band unreachable, and the 951 landscape pose is the one the
     design is for.

     This is app-wide, so it also exposes a plain iPhone in landscape at
     844 × 390 — a pose the drawing never drew. The band rule already answers
     it rather than needing a new decision: nothing insets a compact phone, so
     844 clears the 840 dock line and it docks with the conversation keeping
     exactly its 560 measure. What is untested is the 390pt *height*. */
  orientation: "default",
  scheme: "firetower",
  userInterfaceStyle: "automatic",
  /* Light's page — `--color-ground`, which on a phone is the page rather than
     the chrome. This was `#0b0b0c`, so the first frame of a light launch was
     black, which is the one frame a person reads as a crash.

     **There is only one of these.** `ExpoConfig` has no dark counterpart at
     the top level, so this is the light value and `_layout.tsx` sets the real
     one from the resolved theme through `expo-system-ui` on every change. The
     splash below does have a `dark` branch and takes it.

     Written rather than imported: a dynamic config is evaluated by Expo's own
     loader outside Metro, so it cannot resolve `~/design`. `pnpm test` asserts
     these literals against the generated palette instead, which is what stops
     them drifting. */
  backgroundColor: "#ffffff",
  ios: {
    bundleIdentifier: "com.usefiretower.app",
    /* **The other half of the build claim.** With this false the app runs in
       compatibility mode on the Duo's inner display: it gets a phone-sized
       window in the middle of a larger screen and *none* of the three poses
       happens at all. A design that names 466, 669 and 951 is not shipped by
       drawing them. */
    supportsTablet: true,
    infoPlist: {
      NSAppTransportSecurity: {
        NSAllowsLocalNetworking: true,
        /* And the same again for web content, which is a separate switch.
           `NSAllowsLocalNetworking` covers what the app fetches; a
           `WKWebView` is governed on its own, so without this the artifact
           viewer fails with `-1022` against the very control plane the rest
           of the app is already talking to. Artifacts are served from that
           same origin — on a per-artifact hostname, which is what makes them
           separate origins to a browser — so this grants nothing the app
           does not already reach. */
        NSAllowsArbitraryLoadsInWebContent: true,
      },
      NSLocalNetworkUsageDescription:
        "Firetower connects to control planes you run — including ones on this network.",
      UIBackgroundModes: ["remote-notification"],
      /* Declared rather than left for App Store Connect to ask about on every
         upload. Firetower uses TLS and nothing else — that is exempt, and
         saying so here is the difference between a build that submits and one
         that waits on a form. */
      ITSAppUsesNonExemptEncryption: false,
      /* Said in the app's own words. iOS shows these verbatim in the prompt,
         and "Firetower would like to access your microphone" with no reason
         is the kind of ask people decline. */
      NSMicrophoneUsageDescription:
        "Dictating a message to an agent, when you press the microphone.",
      NSSpeechRecognitionUsageDescription:
        "Turning what you say into text for the composer. It is transcribed on this device.",
      NSPhotoLibraryUsageDescription:
        "Attaching a screenshot to a message, so the agent can look at it.",
      NSCameraUsageDescription: "Taking a picture to attach to a message.",
    },
  },
  android: {
    package: "com.usefiretower.app",
    adaptiveIcon: { backgroundColor: "#0b0b0c", foregroundImage: "./assets/icon.png" },
  },
  icon: "./assets/icon.png",
  plugins: [
    "expo-router",
    "expo-secure-store",
    "expo-font",
    /* SDK 58 moved the status bar to a config plugin; `expo install --fix`
       asks for it by name and cannot write a dynamic config itself. */
    "expo-status-bar",
    /* The image is not optional: without one the plugin still writes a
       `@drawable/splashscreen_logo` reference into values.xml and the Android
       resource link fails on a symbol nothing generated. */
    [
      "expo-splash-screen",
      {
        image: "./assets/splash-icon.png",
        backgroundColor: "#ffffff",
        resizeMode: "contain",
        imageWidth: 160,
        dark: { backgroundColor: "#0b0b0c" },
      },
    ],
    /* Release builds are shrunk. Without this a local `assembleRelease` is
       111 MB — every ABI, unminified — which is fine to sideload once and not
       something to hand anybody.

       No ABI split here: the store path builds an `.aab` and Play delivers one
       architecture per device. This is for the APK that goes to a person
       directly, where one oversized file beats four they have to choose
       between. */
    "expo-speech-recognition",
    [
      "expo-build-properties",
      {
        android: {
          enableProguardInReleaseBuilds: true,
          enableShrinkResourcesInReleaseBuilds: true,
        },
      },
    ],
  ],
  experiments: { typedRoutes: true },

  /* Written by hand because `eas init` cannot edit a dynamic config. The id
     is what ties a build to a project on EAS; the owner is whose account it
     belongs to. */
  owner: "kevinpiac",
  extra: { eas: { projectId: "84533dee-c17d-486d-ae4c-66626538f564" } },
  updates: { url: "https://u.expo.dev/84533dee-c17d-486d-ae4c-66626538f564" },
  runtimeVersion: { policy: "appVersion" },
};

export default config;
