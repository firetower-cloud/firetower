import type { ExpoConfig } from "expo/config";

/**
 * The phone's shell.
 *
 * Two things here are not defaults and are load-bearing:
 *
 * - **Dark, always.** `web/app/globals.css` sets `color-scheme: dark` and the
 *   token set has no light values to fall back to. A phone that respects the
 *   system theme would render half a design system.
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
  version: "0.1.0",
  orientation: "portrait",
  scheme: "firetower",
  userInterfaceStyle: "dark",
  backgroundColor: "#0b0b0c",
  ios: {
    bundleIdentifier: "com.usefiretower.app",
    supportsTablet: false,
    infoPlist: {
      NSAppTransportSecurity: {
        NSAllowsLocalNetworking: true,
      },
      NSLocalNetworkUsageDescription:
        "Firetower connects to control planes you run — including ones on this network.",
      UIBackgroundModes: ["remote-notification"],
      /* Declared rather than left for App Store Connect to ask about on every
         upload. Firetower uses TLS and nothing else — that is exempt, and
         saying so here is the difference between a build that submits and one
         that waits on a form. */
      ITSAppUsesNonExemptEncryption: false,
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
    /* The image is not optional: without one the plugin still writes a
       `@drawable/splashscreen_logo` reference into values.xml and the Android
       resource link fails on a symbol nothing generated. */
    [
      "expo-splash-screen",
      { image: "./assets/splash-icon.png", backgroundColor: "#0b0b0c", resizeMode: "contain", imageWidth: 160 },
    ],
    /* Release builds are shrunk. Without this a local `assembleRelease` is
       111 MB — every ABI, unminified — which is fine to sideload once and not
       something to hand anybody.

       No ABI split here: the store path builds an `.aab` and Play delivers one
       architecture per device. This is for the APK that goes to a person
       directly, where one oversized file beats four they have to choose
       between. */
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
