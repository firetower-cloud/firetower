# Releasing the phone

`eas.json` rejects comments, so the profiles are explained here.

## The profiles

**`development`** — a dev client against Metro. iOS builds for the simulator;
Android is an APK. Not for anybody else's phone.

**`preview`** — what has been used all through the build of this app.
`distribution: internal` means iOS installs over the air onto devices whose
UDID is registered, and Android is a plain APK. On the `preview` channel, so
`eas update --channel preview` reaches it.

**`production`** — what ships. iOS goes to TestFlight; Android is an **APK**,
not an app bundle, because the point of this channel is that somebody scans a
code and installs. An `aab` cannot be installed — it is what Google Play takes
in order to produce APKs itself. If this ever goes to Play, that is a second
artifact from the same profile rather than a replacement for this one.

`autoIncrement` bumps the build number, which Apple requires to be higher than
every build it has already seen. The *version* comes from `app.config.ts` and
is bumped by release-please; this is the number underneath it.

## What the release needs

See `.github/workflows/mobile-release.yml`. The secrets live in the `release`
environment, which requires a reviewer's approval before any job can read one.

| Secret | What it is |
| --- | --- |
| `EXPO_TOKEN` | A robot access token from expo.dev. Lets CI build and submit as the account that owns the credentials. |
| `APPLE_ID` | The Apple account email that owns the App Store Connect app. |
| `ASC_APP_ID` | The App Store Connect app's numeric id — from the app's URL in App Store Connect. |
| `APPLE_TEAM_ID` | The ten-character team id, from the Apple Developer membership page. |

`$VAR` in `eas.json` is read from the environment, so those three Apple values
are ordinary secrets rather than anything written into the repository.

## Apple's review

Only **external** testers — the public link — need Beta App Review, and only
on the first build or after a material change. **Internal** testers, up to 100
people on the App Store Connect team, get every build as soon as processing
finishes, with no review at all.

A reviewer opening this app sees "Connect to a Firetower" and has no
Firetower. Beta App Review requires working demo credentials: either a control
plane reachable from the public internet with an account that can be handed to
Apple, or review notes explicit enough to stand in for one. That is the thing
most likely to hold up a first submission, and it is not a build problem.
