# Where cross-platform desktop verification runs, and what the shell transport costs

Research for [#338](https://github.com/firetower-cloud/firetower/issues/338), under the map at
[#329](https://github.com/firetower-cloud/firetower/issues/329). Blocks
[#334](https://github.com/firetower-cloud/firetower/issues/334).

Read-only on the repository: nothing installed, nothing built, `desktop/src-tauri` untouched. Every
repository claim carries a file and line; every web claim carries a URL. Where something could not be
established it says so rather than guessing.

## The three answers up front

1. **Yes, the plugins can be debug-only, and the upstream documentation says so in as many words:
   "No, the plugin is **test-only**."** The mechanism is a Cargo target gate plus conditional
   registration. A shipped release bundle need not — and should not — carry a WebDriver server.
2. **But the same documentation tells you to test a `--release` binary, and `debug_assertions` is off
   in release.** So the `cfg(debug_assertions)` gate and the thing you actually want to drive are
   mutually exclusive. The resolution is a non-default Cargo *feature*, which means **a second build**.
   That second build is the real cost of the embedded route, not the plugins.
3. **Therefore `desktop.yml` cannot drive the artifact it uploads — not with the embedded provider.**
   It can on Windows and Linux via the external `tauri-driver` route, which needs no plugin in the app
   at all. macOS is the odd one out: embedded-with-a-second-build, or CrabNebula's paid key.

---

## 1. What `@wdio/tauri-service` with `driverProvider: 'embedded'` actually requires

### The two plugins, and what each one is for

| Plugin | Language | What it does | Required when |
|---|---|---|---|
| `tauri-plugin-wdio-webdriver` | Rust only | "Embeds a WebDriver HTTP server." Runs the embedded W3C server inside the app, so no external driver is needed on any platform — **and it is how macOS is supported at all.** | `driverProvider: 'embedded'` only |
| `tauri-plugin-wdio` | Rust + JS | "Provides execute API, mocking support, and log forwarding" — i.e. `browser.tauri.execute()`, command/IPC mocking, and frontend **and backend** log capture | Any provider, for those features. Omit it and you get plain WebDriver |

Sources: [Tauri v2 — WebDriver](https://v2.tauri.app/develop/tests/webdriver/) and
[WebdriverIO — Tauri plugin setup](https://webdriver.io/docs/desktop-testing/tauri/plugin-setup).

The Tauri page is explicit that the embedded server is the default and the reason macOS works:
`@wdio/tauri-service` "works on **Windows, Linux, and macOS**" and "By default, it runs an **embedded
WebDriver server** inside your app, so no external driver is needed on any platform", whereas
`tauri-driver` direct "only Windows and Linux are supported on desktop, as macOS has no WKWebView
driver tool available"
([v2.tauri.app](https://v2.tauri.app/develop/tests/webdriver/)).

`tauri-plugin-wdio` is the one that matters for a verification skill beyond clicking: without it there
is no `browser.tauri.execute()`, so nothing in the app's Rust side can be called or read, no IPC
command can be mocked, and the app's own `console` and Rust `log` output is not collected. The
quick-start marks it "⚠️ The `tauri-plugin-wdio` is required for testing", then qualifies it: "Skip
this section only if you want basic WebDriver operations without mocking or log capture"
([quick-start](https://webdriver.io/docs/desktop-testing/tauri/quick-start)).

### The three providers

| `driverProvider` | Platforms | External driver | Plugin in the app |
|---|---|---|---|
| `'embedded'` | Windows, Linux, macOS | No | `tauri-plugin-wdio-webdriver` required |
| `'official'` | Windows, Linux **only** | `tauri-driver` + msedgedriver / WebKitWebDriver | None required |
| `'crabnebula'` | Windows, Linux, macOS | `@crabnebula/tauri-driver` | macOS also needs `tauri-plugin-automation` |

Source: [WebdriverIO — Tauri configuration](https://webdriver.io/docs/desktop-testing/tauri/configuration/),
which gives the exact strings: `'embedded': Use embedded WebDriver server via tauri-plugin-wdio-webdriver`,
`'official': Use the cargo-installed tauri-driver`, `'crabnebula': Use @crabnebula/tauri-driver from npm`.

Other config worth knowing: `embeddedPort` defaults to `4445`, and "Each worker instance gets a unique
port (basePort + workerIndex)"; `autoDownloadEdgeDriver` defaults to `true` and is "Windows only,
ignored on Linux/macOS"; `appBinaryPath` is a path to the compiled binary, e.g.
`'./src-tauri/target/release/my-app.exe'`. On Linux "WebKitWebDriver is auto-detected" and "Xvfb is
auto-detected if available (WebdriverIO 9.19.1+)" — there is no Xvfb option to set
([configuration](https://webdriver.io/docs/desktop-testing/tauri/configuration/)).

The embedded server "runs on **port 4445** by default" and binds to loopback.

### CAN THEY BE DEBUG-ONLY? Yes — with a catch that changes the whole costing

**The direct answer, quoted.** The plugin-setup page carries an FAQ entry:

> **Should I Include the Plugin in Production?**
>
> "No, the plugin is **test-only**."

— [https://webdriver.io/docs/desktop-testing/tauri/plugin-setup](https://webdriver.io/docs/desktop-testing/tauri/plugin-setup)

And the mechanism, verbatim from the same page. The dependency is declared under a target gate rather
than in `[dependencies]`:

```toml
[target.'cfg(debug_assertions)'.dependencies]
tauri-plugin-wdio-webdriver = "1"
```

and registered conditionally:

```rust
#[cfg(debug_assertions)]
let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
```

with the same shape for the other plugin:

```rust
#[cfg(debug_assertions)]
{
    builder = builder.plugin(tauri_plugin_wdio::init());
}
```

Capabilities are the other half. The page's example grants `"wdio:default"` alongside `core:default`;
the minimum for execute and mocking is `"wdio:allow-execute"`, and the embedded plugin wants
`"wdio-webdriver:default"` ([plugin-setup](https://webdriver.io/docs/desktop-testing/tauri/plugin-setup),
[platform-support](https://webdriver.io/docs/desktop-testing/tauri/platform-support)). **A capability
entry is not itself gated by `cfg`** — `capabilities/default.json` is static JSON read at build time —
so a permission naming a plugin that was compiled out is a build-time hazard in its own right. Either
put the wdio permissions in a separate capability file only the test build includes, or accept that
`default.json` names a plugin the release build does not have. This file is already blunt about what
Tauri does with permissions it disagrees with: it "denies every plugin command that is not listed
here, and denies it silently" (`desktop/src-tauri/capabilities/default.json:4`). I could not establish
from the docs whether a permission for an absent plugin is a hard build error or a silent no-op; it
needs one five-minute experiment before anybody relies on either answer.

**So: a shipped `.dmg`, `.msi` or `.AppImage` need not contain a WebDriver server, and the recommended
setup is that it does not.** That is the security answer, and it is a clean yes.

**The catch.** The quick start says, verbatim, "# Build for release (required for testing with
WebdriverIO)" followed by `cargo build --release`, and its config points `appBinaryPath` at
`./src-tauri/target/release/my-app.exe`
([quick-start](https://webdriver.io/docs/desktop-testing/tauri/quick-start)). `cargo build --release`
has `debug_assertions` **off**. A binary built that way with the gate above does not contain the
plugin, so the embedded provider has nothing to connect to. The two pages contradict each other.

The resolution is in the same plugin-setup page, as the alternative gate — a non-default Cargo feature:

```toml
[features]
wdio = ["dep:tauri-plugin-wdio"]

[dependencies]
tauri-plugin-wdio = { version = "1", optional = true }
```

```rust
#[cfg(feature = "wdio")]
{
    builder = builder.plugin(tauri_plugin_wdio::init());
}
```

This is the shape to use here, because it is the only one that gives a *release-profile* binary with
the server in it while leaving the default release build clean. The cost is stated plainly:

> **A verification build is a different binary from the shipped one.** Not a different profile — the
> same `--release` optimisation — but a different feature set, so a different compilation. The
> artifact `desktop.yml` uploads today cannot be driven by the embedded provider, and no amount of
> configuration changes that.

Whichever gate is chosen, the thing to verify before trusting it is that a plain `tauri build` with no
features still succeeds and still produces a bundle with no server in it. That is a `cargo tree
--no-default-features` plus a `strings`-grep on the bundle, and it belongs in the skill's Doctor
section, not in somebody's memory.

---

## 2. What it costs per operating system

### macOS

- **Embedded is the only free route.** `tauri-driver` has no macOS support: "macOS has no WKWebView
  driver tool available" ([v2.tauri.app](https://v2.tauri.app/develop/tests/webdriver/)). The service
  "**auto-detects** the embedded provider — no explicit `driverProvider` configuration is needed" on
  macOS, provided `tauri-plugin-wdio-webdriver` is installed and registered
  ([platform-support](https://webdriver.io/docs/desktop-testing/tauri/platform-support)).
- So macOS *requires* the second build described above. There is no plugin-free macOS route.
- The `.app` already exists at a known path on the CI leg:
  `desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos/Firetower.app`
  (`desktop/scripts/build-mac.sh:28-32`), and the leg builds `--bundles app`
  (`.github/workflows/desktop.yml:55`). An unsigned local `.app` is launchable — Gatekeeper's prompt
  is a *quarantine* consequence of downloading, which a file built in place does not have
  (`desktop/scripts/build-mac.sh:7-8` describes the downloaded case).
- **Unresolved and worth one spike:** whether a Depot/GitHub macOS runner has enough of a window
  server session to launch a GUI app and have WKWebView render. There is direct evidence in this
  repository that such a runner has *less* session than a desktop: "Tauri's own DMG script arranges
  the window through Finder, which a build machine has no session for; this assembles the image
  instead" (`.github/workflows/desktop.yml:158-159`). That is specifically Finder/AppleScript
  automation, which is a stricter requirement than drawing a window, so it is suggestive rather than
  decisive. I could not establish either way from the docs. **This is the single largest open risk in
  the whole embedded route**, because if the macOS runner cannot host a rendering WKWebView then macOS
  — the platform most of the team develops on and the one furthest from Chrome — gets no real-binary
  coverage in CI at all.
- No entitlement or signing requirement for WebDriver is mentioned in the docs. `entitlements.plist`
  is already referenced for the bundle (`desktop/src-tauri/tauri.conf.json:56`); whether the embedded
  server needs anything added to it is not stated anywhere I found.

### Windows

- **`'official'` is the recommended provider**, i.e. `tauri-driver` driving `msedgedriver.exe`, and it
  "uses tauri-driver + MSEdgeDriver with auto-management"
  ([platform-support](https://webdriver.io/docs/desktop-testing/tauri/platform-support)).
- **Version matching is the whole of the operational risk**, and the service handles it:
  `autoDownloadEdgeDriver: true` is the default and the service "automatically detects WebView2
  version, downloads matching MSEdgeDriver, handles mismatches". The documented failure is "**Version
  mismatch between driver and WebView2**"; the manual escape is to read the app `.exe`'s
  Properties → Details → File version and fetch the matching driver.
- **No plugin needed in the app** for basic WebDriver operations on this route — so **Windows can
  drive the exact binary `desktop.yml` already builds**, with no second build and no server anywhere
  near a shipped bundle. That is a materially better security and cost story than embedded, and it is
  the reason to prefer `'official'` here.
- The trade is `browser.tauri.execute()`, IPC mocking and log capture, which need `tauri-plugin-wdio`
  and therefore a second build again. A route that gives DOM, clicks, window geometry and screenshots
  against the real artifact is worth a lot on its own; see §5 for exactly which rows of `bridge.ts`
  need `tauri.execute()` and which do not.
- Note the bundle config: `webviewInstallMode: downloadBootstrapper`
  (`desktop/src-tauri/tauri.conf.json:47-49`) and NSIS `installMode: currentUser` (`:50-52`). A
  `windows-2022` runner has WebView2 preinstalled, so the bootstrapper path is not exercised by a CI
  run — which is itself a thing CI cannot prove.

### Linux

- **`'official'` again**, `tauri-driver` + WebKitWebDriver, and the driver is a *manual* install:
  `sudo apt-get install -y webkit2gtk-driver` on Debian/Ubuntu
  ([platform-support](https://webdriver.io/docs/desktop-testing/tauri/platform-support)). Fedora 40+,
  Arch and Void are listed as supported; Alpine (musl), CentOS Stream/RHEL 9 (glib too old) and
  openSUSE are listed as **not** supported. Ubuntu 22.04 — what this repo builds on — is in the
  supported column.
- **Yes, Linux needs a virtual display, and `xvfb-run` is the documented answer.** Quoted: "Use Xvfb
  for headless testing: `xvfb-run -a npm run test:e2e`"
  ([troubleshooting](https://webdriver.io/docs/desktop-testing/tauri/troubleshooting)). There is an
  automatic path too — "Xvfb is auto-detected and used if available (requires wdio 9.19.1+)" — so
  installing the `xvfb` package may be sufficient without wrapping the command. Under Wayland,
  `export GDK_BACKEND=x11` is the documented workaround. The symptoms if you skip it are "X11
  connection refused" or "Cannot open display".
- `desktop.yml` already installs `libwebkit2gtk-4.1-dev` (`:98`); `webkit2gtk-driver` and `xvfb` would
  be two more packages on the same `apt-get` line, which is about as cheap as an addition gets.
- The published Linux limitations matter for what is worth asserting there at all: no tray icon, no
  badge, no poster images on artifacts, and the top window corners do not resize diagonally
  (`docs/linux.md:48-62`). Several of those are *absences to assert*, not features to drive — see §5.

### Is the external route preferable on Windows and Linux?

**Yes, for the reason that has nothing to do with WebDriver and everything to do with what gets
driven:** `'official'` needs no plugin in the app, so it drives **the release artifact the matrix
already produces**, with no second compilation and no possibility of a server reaching a shipped
bundle. Embedded's advantages — one mechanism across three platforms, no external driver to install
or version-match — are real but are convenience; the plugin-free property is a security and cost
property. The recommendation that falls out: **`'official'` on Windows and Linux, `'embedded'` on
macOS**, and accept that macOS is a second build or is not covered.

### CrabNebula's fork and the paid macOS key — CONFIRMED

The claim in the ticket is correct. CrabNebula ships a cross-platform fork of `tauri-driver`
(`@crabnebula/tauri-driver` on npm) and **macOS specifically requires a paid subscription**:

- Tauri's own page lists it as a provider: "**CrabNebula:** Cross-platform fork of tauri-driver
  requiring 'a paid API key' for macOS support"
  ([v2.tauri.app](https://v2.tauri.app/develop/tests/webdriver/)).
- WebdriverIO's platform-support page: "Windows: Yes (no API key required); Linux: Yes (requires
  webkit2gtk-driver; no API key required); macOS: Yes (requires `CN_API_KEY` environment variable and
  `tauri-plugin-automation`)", described as a "Paid cross-platform alternative"
  ([platform-support](https://webdriver.io/docs/desktop-testing/tauri/platform-support)).
- Corroborated independently by CrabNebula's own plugin docs and by WebdriverIO's CI, which has a pull
  request titled "ci(tauri): skip CrabNebula E2E on macOS when CN_API_KEY is absent"
  ([docs.crabnebula.dev](https://docs.crabnebula.dev/plugins/tauri-e2e-tests/),
  [webdriverio/desktop-mobile#641](https://github.com/webdriverio/desktop-mobile/pull/641)).

One correction to the framing, though: **CrabNebula is not plugin-free on macOS either** — it needs
`tauri-plugin-automation` in the app plus `@crabnebula/test-runner-backend`. So paying does not buy
back the ability to drive the shipped artifact. It buys a single driver across three platforms. On
this analysis there is no reason to spend it: the free combination (`'official'` on Windows/Linux,
`'embedded'` on macOS) covers the same ground.

Also noted in passing, not researched: `danielraffel/tauri-webdriver` advertises itself as an
open-source macOS WebDriver for Tauri apps. Unvetted — mentioned only so nobody has to rediscover that
it exists.

---

## 3. Is `desktop.yml`'s existing matrix the natural home?

`.github/workflows/desktop.yml` read in full (171 lines).

### The matrix, exactly

| Runner (`:53`, `:58`, `:69`) | `platform` | Bundle targets (`args`) | Artifact name | Glob |
|---|---|---|---|---|
| `depot-macos-latest` | `mac` | `--target universal-apple-darwin --bundles app --config src-tauri/unsigned.conf.json` | `firetower-macos` | `desktop/src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg` |
| `depot-windows-2022` | `windows` | `--bundles nsis,msi --config src-tauri/unsigned.conf.json` | `firetower-windows` | `desktop/src-tauri/target/release/bundle/nsis/*.exe` and `.../bundle/msi/*.msi` |
| `depot-ubuntu-22.04` | `linux` | `--bundles deb,appimage --config src-tauri/unsigned.conf.json` | `firetower-linux` | `desktop/src-tauri/target/release/bundle/deb/*.deb` and `.../bundle/appimage/*.AppImage` |

`fail-fast: false` (`:50`), `working-directory: desktop` for every step (`:77-79`),
`if-no-files-found: error` on the upload (`:171`). Triggers: `workflow_dispatch` and `pull_request` on
paths `desktop/**`, `api/openapi.json`, `.github/workflows/desktop.yml`,
`.github/workflows/desktop-release.yml`, `.github/scripts/appimage-*.sh` (`:17-34`), with
release-please branches excluded twice (`:22-23`, `:48`). `permissions: contents: read` (`:36-37`) and
no secrets — "safe for a pull request from a fork" (`:6-7`). Concurrency group per ref,
cancel-in-progress (`:39-41`).

Note the macOS asymmetry: the leg builds `--bundles app`, and the `.dmg` the glob collects is
assembled afterwards by `desktop/scripts/make-dmg.sh` (`:160-166`) because "Tauri's own DMG script
arranges the window through Finder, which a build machine has no session for" (`:158-159`).

Ubuntu 22.04 rather than 24.04 is deliberate: "glibc is forward- but not backward-compatible, so the
oldest distribution we build on is the oldest one the `.deb` installs on" (`:65-68`).

### Linux system packages it installs (`:94-100`)

```
libwebkit2gtk-4.1-dev libgtk-3-dev libxdo-dev libssl-dev
libayatana-appindicator3-dev librsvg2-dev
libdbus-1-dev xdg-utils
```

The last two are documented as the ones nobody's list has: `libdbus-1-dev` because `keyring`'s
`sync-secret-service` feature pulls `dbus-secret-service → dbus → libdbus-1` and "without it the build
fails in `dbus-sys`, which names nothing recognisable"; `xdg-utils` because the AppImage bundler copies
`/usr/bin/xdg-open` into the AppDir (`:83-93`).

### What it already does before bundling

`pnpm install --frozen-lockfile`, `pnpm tsc --noEmit`, `pnpm test`, `cargo clippy --locked
--all-targets -- -D warnings`, `cargo test --locked` (`:121-134`), with `Swatinem/rust-cache` keyed on
`desktop/src-tauri` (`:117-119`). `playwright-core` is already a devDependency of `desktop/`
(`desktop/package.json:51`), so the Chrome transport's own dependency is present on all three legs
already.

### Measured cost today

Run [43935423475](https://github.com/firetower-cloud/firetower/actions/runs/43935423475) (branch
`agent/fix-scroll-issue`, success, warm `rust-cache`):

| Leg | Whole job | `tauri-action` bundle step alone |
|---|---|---|
| macOS universal | 133s | 34s |
| Windows 2022 | 470s | 110s |
| Ubuntu 22.04 | 312s | 140s |

Wall clock for the matrix, ~7m52s. Windows is the slow leg and it is slow before it bundles anything —
63s for the Rust toolchain, 51s for the cache restore, 36s for `pnpm test`.

### The comment about the Rust tests and the Windows machine

From `.github/workflows/desktop.yml:126-132`, verbatim:

> ```
> # The shell's own tests, on all three platforms, which is the only
> # instrument there is for the keychain on Windows: nobody has a Windows
> # machine to drive, so what the OS keychain's failures are *read as* has
> # to be asserted rather than measured. `main.rs`'s tests carry the error
> # shapes each backend really produces and check that none of them is
> # read as "there is no credential here". Running them here is what makes
> # that true of Windows and not only of this Mac.
> ```

`main.rs` says the same thing from the other side (`desktop/src-tauri/src/main.rs:411-414`):

> **These tests are the only instrument we have for Windows.** There is no Windows machine on this
> fleet and nobody has driven the keychain there, so the thing that has to be true — that a Credential
> Manager a policy has closed is never read as "there is no credential here" — cannot be measured.

**What it implies about the gap.** The repository has already identified, named and worked around
exactly the gap this ticket exists to close, and the workaround it chose is *unit tests of the mapping
with hand-written error shapes*. Two things follow. First, the honest description of the current state
is not "untested" but "tested against a transcription of what the platform is believed to do" — and a
transcription is only as good as the reading of `keyring` 3.6.3 that produced it, which the comment is
careful to say was a reading and not a guess (`main.rs:419-432` even tabulates which error codes reach
`NoStorageAccess` per backend). Second, and this is the actual prize: **a real-binary route on the
Windows leg would make `secret_set` → `secret_get` → `secret_delete` against a live Credential Manager
the first *measurement* of that path that has ever existed.** The same run on the Linux leg would
measure the no-Secret-Service-on-the-bus case that `docs/linux.md:9-11` promises behaves a particular
way. Of everything in this ticket, that is the finding with the highest ratio of value to cost, and it
argues for putting the real-binary route exactly where that comment is: in `desktop.yml`.

### So: small addition or large one?

**Small per leg, with one large caveat, and the caveat is the second build — not the wiring.**

The cheap parts, as concrete steps to add to the existing job:

1. `apt-get` line (`:94-100`): append `webkit2gtk-driver xvfb`. Linux only. One line.
2. `cargo install tauri-driver --locked` on the Windows and Linux legs, or the npm equivalent the
   service manages. One step, cached by `rust-cache` on Linux; a cold `cargo install` is minutes, so
   pin and cache it or take it from a release.
3. A `wdio.conf.ts` plus a `verify` script in `desktop/package.json`, and `@wdio/tauri-service` in
   `devDependencies` — which is a `pnpm-lock.yaml` change, nothing more.
4. One run step after the existing `tauri-apps/tauri-action` step, pointing `appBinaryPath` at the
   binary the bundle step just produced, wrapped in `xvfb-run -a` on Linux.
5. Upload the evidence — screenshots, logs — as a second artifact beside the installer, exactly as
   `:167-171` already does.
6. `continue-on-error: true` on that step for the first few weeks, because a flaky verification leg
   that blocks every `desktop/` pull request will be deleted rather than fixed.

The expensive part:

7. **A second build on the macOS leg** (and on Windows/Linux too, if `browser.tauri.execute()` and log
   capture are wanted there). `cargo build --release --features wdio` after the bundle step. The
   measured bundle steps are 34s / 110s / 140s on a warm cache; a feature-set change recompiles
   `firetower-desktop` and the plugin's dependency subtree, so **estimate** +1–3 minutes per leg. That
   number is an estimate and is not measured — nothing was built for this ticket. It is also the first
   thing to measure in the prototype, because it decides whether this lands in `desktop.yml` or in a
   separate workflow with its own trigger.

Plus one judgement call that is not a step: the verification leg has to be on a **separate job** or the
existing one grows a dependency on a GUI session, and the macOS risk in §2 becomes a risk to the
installer build that everybody depends on. `needs:` the build job and download its artifact, or add the
steps to the same job behind `continue-on-error`. The former is cleaner and costs a cache restore.

**Verdict: `desktop.yml` is the right home.** Three OSes, the real bundler, the real installers, warm
caches, no secrets, and a comment in the file already asking for precisely this. Nothing else in the
repository has any of that. The honest caveat is that "driving the artifact it just built" is literally
true on Windows and Linux via `'official'` and literally false on macOS, where it is "driving a
second binary built from the same commit with one extra feature".

---

## 4. What a Firetower machine in a fleet offers that a CI runner does not

### The appeal, stated fairly

A CI runner is a black box that reports after the fact. A machine in a Firetower fleet is a machine an
agent is *already sitting on*, over ssh, with tmux — so when a verification run says something looks
wrong, the agent can keep poking: re-run one step, read a file, try the gesture again, take another
screenshot. `docs/host-execution.md:103-109` describes exactly that posture: the worker "runs agents
under tmux, so they outlive the connection", keeps state under `~/.firetower/worker`, and "reaches a
port a session is serving through the connection Firetower already holds, so nothing is published".
That last clause is the interesting one — it is already a tunnel, so a VNC or noVNC on the machine
would be reachable without opening a port, which is the shape an interactive GUI session would take.

### Two hard facts that mostly settle it

**1. There is no Windows machine in a Firetower fleet. There cannot be one.**
`install/worker.sh:73`:

> ```
> MINGW*|MSYS*|CYGWIN*) die "Windows is not a worker platform. Install into WSL2, which is Linux from here on." ;;
> ```

and `docs/host-execution.md:48-49`: the installer "works out what the machine is — macOS or Linux,
arm64 or x86_64 — and refuses anything else with a sentence. Windows runs it inside WSL2."

A WSL2 machine is Linux from the worker's point of view. It cannot build a `.msi`, cannot host WebView2,
and cannot run `msedgedriver`. **So the fleet route cannot cover Windows at all** — which is the
platform the repository says it has never measured (`main.rs:411`). The fleet route misses the gap it
would most be wanted for.

**2. A fleet machine is headless in the same way a CI runner is.**
An ssh command "gets the daemon's own PATH" and the worker runs everything through the account's login
shell environment (`docs/host-execution.md:87-95`). Nothing in there is a graphical session. A Linux
fleet machine would need `xvfb-run` exactly as the CI runner does, and a macOS fleet machine reached
over ssh has the same window-server question as the macOS runner — arguably worse, because an ssh
session on macOS is not in the console user's Aqua session at all unless somebody is logged in at the
screen. So "interactive" does not come for free; it comes from adding a display server and a remote
viewer that nobody has built.

### What it would actually require

- A Linux (or macOS) machine added to the fleet per `docs/host-execution.md:17-35` — key into
  `authorized_keys`, address, account, install the worker. Cheap and already documented.
- Xvfb or a real seat on it, plus x11vnc/noVNC if "interactively" is to mean anything a person or an
  agent can look at.
- `webkit2gtk-driver` and the app's dependencies installed by hand, because Firetower "does not install
  system packages, configure sudo, switch accounts or open a port" (`docs/host-execution.md:111-113`)
  and "Firetower never runs sudo on a machine" (`:33-35`). Every system package is a human step.
- A built artifact delivered to it — which means either building on that machine or shipping the CI
  artifact across.
- And it is **one machine, one OS, one sample**, maintained by hand, versus three runners that are
  rebuilt from scratch every run.

### Assessment

**Not worth it for cross-platform verification; possibly worth it for debugging one.** The fleet route
cannot do Windows, needs the same virtual display as CI, needs hand-installed packages Firetower
deliberately will not install, and gives one platform instead of three. As the *home* for the shell
transport it is strictly worse than `desktop.yml` on every axis that matters.

Where it earns its keep is the follow-up: when the Linux leg fails in CI with a screenshot that makes
no sense, a Linux machine in the fleet with the artifact on it is somewhere an agent can reproduce it
and keep hold of it. That is a debugging affordance, not a verification transport, and it does not need
to be built before the transport is. #329 files this under "Not yet specified" as speculative and
hanging on where cross-platform verification lands; it lands in CI, and this stays speculative.

One caveat on my own confidence: I did not test whether a worker can launch a GUI app under
`xvfb-run` through tmux over ssh. I expect it to work on Linux because nothing about it is unusual, but
it is unmeasured.

---

## 5. Which of `bridge.ts`'s surface each route can prove

`desktop/src/bridge.ts`, 257 lines. Its header claims to be "The entire surface that differs between
Tauri and Electron" (`:1-12`), with a Tauri implementation (`:201-255`) and a browser implementation
that is "a no-op so `pnpm dev` renders in an ordinary tab" (`:163-199`), selected by whether
`window.__TAURI_INTERNALS__` exists (`:204-205`).

### First finding: `bridge.ts` is not the whole native surface

Four other modules reach the Tauri API directly, past the bridge:

| File | What it brokers | Native API |
|---|---|---|
| `desktop/src/open.ts:11-19` | Opening a link in the system browser | `@tauri-apps/plugin-opener` `openUrl` |
| `desktop/src/drag.ts:60-91` | Titlebar drag, double-click to maximise | `@tauri-apps/api/window` `startDragging()`, `toggleMaximize()` |
| `desktop/src/update.ts:80-146` | The updater: version, check, relaunch | `plugin-updater`, `api/app`, `plugin-process` |
| `desktop/src/telemetry.ts:92` | App version in telemetry | `api/app` `getVersion` |

Plus `desktop/src/ui/Resize.tsx` (via `drag.ts`'s exported `tauriWindow()`), the Windows-only tray
(`desktop/src-tauri/src/tray.rs`, `#![cfg(target_os = "windows")]`), and the HTML5 file-drop path
(`desktop/src/ui/drop.ts`, `desktop/src/skills.ts:168-181`) which exists *because* Tauri's own
drag-drop handler is switched off (`tauri.conf.json:22`, `tauri.macos.conf.json:11`).

**For the skill this matters directly:** a "what this skill cannot prove" section scoped to `bridge.ts`
would silently omit the updater, the opener, the titlebar drag and the tray. The enumeration below
covers the bridge first, then those.

### The table

Columns: **Chrome** = `playwright-core` against Vite on `:5273`. **Real binary** = WebDriver against a
built binary on the OS that built it; `tauri.execute()` marks rows that additionally need
`tauri-plugin-wdio`, i.e. the second build.

| # | Capability (`bridge.ts`) | Tauri command (`main.rs`) | Chrome frontend route | Real-binary WebDriver route | Residual — unverifiable by either |
|---|---|---|---|---|---|
| 1 | `native: boolean` (`:49`) | — | **No.** Always `false` by construction (`:164`) — the browser branch is the one under test | **Yes.** `true` is the precondition for every other row; asserting it is the cheapest smoke test there is | — |
| 2 | `setTitle` (`:50`) | `set_title` (`:23`) | **No.** Browser branch sets `document.title` (`:165`) — a different thing | **Partly.** `tauri.execute()` reading `window.title()` proves the shell took it. Plain WebDriver sees only `document.title` | Whether the OS window manager *displays* it. With `decorations: false` on Windows/Linux (`tauri.conf.json:21`) it is not drawn at all, so there is nothing to observe |
| 3 | `setBadge` (`:51-52`) | `set_badge` (`:32`) | **No.** No-op (`:166`) | **Barely.** That the command returns without error, and on Windows that `tray::waiting` was reached (`main.rs:48`) | **The badge itself.** Dock badge on macOS, taskbar overlay + tray icon on Windows, nothing at all on Linux (`docs/linux.md:51-53`). None of it is in the webview, so no webview-level driver can see it. Needs a whole-screen capture and an OS-specific assertion |
| 4 | `notify` (`:53`) | `notify` (`:53`) | **No.** No-op (`:167`) | **Barely.** Command returns; `tauri.execute()` could confirm the plugin was called | **The notification.** An OS-level surface. On a Linux CI runner there is usually no notification daemon on the bus at all, so even a real run proves nothing about a real desktop |
| 5 | `minimize` (`:54`) | `minimize` (`:59`) | **No.** No-op (`:168`) | **Yes.** `tauri.execute()` → `isMinimized()`. Plain WebDriver can often infer it from the webview going non-visible | Whether it animates/docks the way that OS does |
| 6 | `zoom` (`:55`) | `zoom` (`:311-313`) | **No.** No-op (`:169`) | **Yes, and this one is worth doing.** `zoom` is maximise-or-restore depending on `is_maximized()`; a real run proves the toggle both ways, and `window.innerWidth` is observable even without `tauri.execute()` | How "maximise" differs per OS — zoom on macOS is not maximise on Windows — is observable but needs a per-OS expectation written down |
| 7 | `close` (`:56`) | `close` (`:176`) | **No.** No-op (`:170`) | **Yes**, as session termination. Destructive: it ends the WebDriver session, so it is the last step of a run or its own run | Whether anything is persisted on the way out; whether the process actually exits |
| 8 | `save(url, suggested, token, onPhase)` (`:67-72`) | `save_download` (`:196`) | **Partly, and misleadingly.** The browser branch is a genuinely different gesture — `fetch` + blob + `<a download>` (`:175-194`), which `bridge.ts:62-65` is at pains to say is "*not* the same gesture dressed differently". Chrome proves the React app's phase handling and the error path, nothing else | **Partly.** The `compressing → downloading` phase channel and the `asError` unwrapping (`:43-45`, `:232-234`) are provable with IPC mocking via `tauri-plugin-wdio`. The real streamed write is not | **The native save sheet.** `tauri-plugin-dialog`'s sheet is an OS modal outside the webview; no WebDriver can click it. So the real end-to-end — pick a path, stream a large file to it, see it on disk — is unreachable by any automated route here. This is the clearest "cannot prove" row in the file |
| 9 | `shoot(url)` (`:81`) | `capture::capture_poster` | **No.** Always `null` (`:195`); the comment explains a tab cannot read a cross-origin frame's pixels (`:74-80`) | **Yes, and only here.** Real PNG bytes come back; `tauri.execute()` or a round-trip through the app can assert a PNG magic number and plausible dimensions | Whether the *picture is of the right thing* — that is a visual judgement, and comparing it to a prototype is `assert-design.mjs`'s job, not this one |
| 10 | `canShoot()` (`:93`) | `capture::capture_supported` | **No.** Hardcoded `false` (`:196`) | **Yes — this is a per-OS constant and the three legs read three values.** `capture.rs:277` `SUPPORTED = true` on macOS, `:375` `true` on Windows, `:501-503` `false` elsewhere. Asserting `true/true/false` across the matrix is one line per leg and proves the build-time fact the interface acts on (`bridge.ts:82-92`) | — |
| 11 | `loadArtifact(url)` (`:103`) | `load_artifact` (`:335`) | **No, and the reason is the point.** `null` in a browser, where the iframe loads the URL directly (`:197`, `:94-102`). The mixed-content refusal the native path exists to dodge **never happens on Vite**, because `http://localhost:5273` is not a secure context in the way `tauri://localhost` is | **Yes, and only here.** A real binary is a secure origin with the CSP at `tauri.conf.json:28` actually applied, so the `srcdoc` path and the refusal it works around are both reachable | Needs a real artifact served over plain http to point at — a Tier B/C fixture, not a transport problem |
| 12 | `secrets: Keychain \| null` — `get`/`set`/`delete` (`:104-105`, `:138-142`, `:249-253`) | `secret_get` (`:148`), `secret_set` (`:157`), `secret_delete` (`:168`) | **No.** `null` (`:198`); `servers.ts:84` reads it straight through, and `bridge.ts:104` says what a tab does instead — "A browser tab has none and keeps them beside the registry". Chrome proves the `Said`/`Done` switch in `servers.ts` against mocks (`servers.test.ts`) and nothing about a keychain | **Yes — and this is the highest-value row in the table.** A real round-trip on each leg hits macOS Keychain, Windows Credential Manager and Secret Service respectively. On Windows it would be **the first measurement** of the path `main.rs:411-414` says has never been measured. On Linux a CI runner with no Secret Service on the bus should produce `{says:"unknown"}` and not `{says:"absent"}` — exactly the distinction `bridge.ts:108-119` says is "the whole of this type", and exactly what `docs/linux.md:9-11` promises a user | The *refusal* cases stay out of reach: a locked login keyring, a macOS keychain that will not grant without a prompt, a Credential Manager closed by group policy. Those need a configured machine, not a fresh runner. So `held` and `absent` become measurable; `unknown`-by-refusal stays asserted in unit tests |

### Past the bridge

| Capability | Chrome | Real binary | Residual |
|---|---|---|---|
| **System-browser auth / external links** (`open.ts:11-19`) | **No.** Falls to `window.open` (`:18`) — a tab, which is a different outcome | **Partly.** That `openUrl` resolves without rejecting. The deep links `x-apple.systempreferences:*` and `ms-settings:*` need capability entries or they are "a button that does nothing" (`capabilities/default.json:22-23`) — the real binary is where a missing entry shows up, since Tauri "denies every plugin command that is not listed here, and denies it silently" (`:4`) | **That the browser or settings pane actually opened.** Automation cannot follow the URL out of the app. On a CI runner there may be no default browser to open it. If any journey ever depends on completing something in that browser and coming back, it is unverifiable by every route here |
| **Titlebar drag / double-click maximise** (`drag.ts:72-91`) | **No.** `tauriWindow()` returns `null` (`:62`), so `onMouseDown` is inert. Chrome proves only the `CONTROLS` opt-out logic (`:74`) | **Doubtful, and I would not promise it.** `startDragging()` hands the pointer to the OS window server, and `drag.ts:33-38` records that "the webview usually does not see the `mouseup` that ends a native drag — the window server has the mouse by then". A WebDriver `performActions` drag is likely to lose the pointer mid-gesture in the same way. Needs a spike before anybody claims it | The four-attempt history in `drag.ts:1-26` is per-platform by nature: `-webkit-app-region` is Chromium-only and silently dead under WKWebView (`:7-8`); AppKit's overlay strip fights `data-tauri-drag-region` (`:9-12`). Those are macOS facts a Linux or Windows run cannot see, and vice versa |
| **The eight resize strips** (`ui/Resize.tsx`, via `drag.ts:60`) | **No** | **Doubtful**, same reason | `docs/linux.md:58-62`: the top corners do not resize diagonally on Linux because "the top five pixels are the toolkit's". A per-OS absence to assert, not a feature to drive |
| **Real OS file drops** (`ui/drop.ts`, `skills.ts:168-181`) | **Partly, synthetically.** CDP can synthesise a `DataTransfer`; `skills.test.ts` and `drop.test.ts` already fake `webkitGetAsEntry` (`drop.test.ts:23`). That proves the parsing, not the drop | **No better, and possibly worse.** There is no WebDriver command to drop an OS file onto a window. `dragDropEnabled: false` (`tauri.conf.json:22`, `tauri.macos.conf.json:11`) means this rides the *webview's own* HTML5 path, and `drop.ts:6-12` records that getting Tauri to let go of it was half the bug | **A real folder dragged from Finder, Explorer or Nautilus.** Three webviews' implementations of `webkitGetAsEntry` on a real OS drop, which is where a folder-vs-files difference would actually bite (`skills.ts:4`). Unverifiable by any automated route in this ticket. **Needs a human.** |
| **The updater** (`update.ts`) | **No.** Mocked in `update.test.ts` | **No, not meaningfully.** Needs two signed versions and a live `latest.json`; the CI legs build with `createUpdaterArtifacts: false` (`unsigned.conf.json:2`) precisely so an unsigned build never hands out an update | The Linux self-replacement of the running AppImage (`docs/linux.md:26-38`) and the Windows elevation prompt. Release-workflow territory, not this skill's |
| **Windows tray** (`src-tauri/src/tray.rs`) | **No** | **No.** Outside the webview entirely | The whole of it. macOS deliberately has none; Linux has none (`docs/linux.md:48-50`) |
| **Window-state persistence** (`tauri_plugin_window_state`, `main.rs:353`) | **No** | **Yes.** Two sequential sessions: move/resize, quit, relaunch, read geometry. Only the real binary has a window to persist | Multi-monitor and display-change cases |
| **The CSP** (`tauri.conf.json:28`) | **No, and this is a silent hole.** Vite serves no CSP, so a resource the shipped app would refuse loads fine in Chrome | **Yes, cheaply.** The bundled app applies it. Console/log capture via `tauri-plugin-wdio` turns a CSP violation into a test failure | — |
| **Per-OS platform detection** (`platform.ts:28-38`) | **Only by pretending.** `?platform=windows` works, but only in a dev build (`:22-26`), and the comment says why it exists: "None of that was inspectable from a Mac, so none of it was looked at" (`:20`) | **Yes, genuinely.** Detection reads `userAgentData?.platform` first, falling back to `navigator.platform` (`:31`) — and `userAgentData` is Chromium-only, unimplemented in WebKit ([caniuse](https://caniuse.com/mdn-api_navigator_useragentdata)). So **WKWebView and WebKitGTK take the fallback branch and Chrome never does.** Only a real binary on each OS proves all three land on the right value | — |
| **The titlebar's per-OS mechanism** | **No.** Chrome has one window chrome | **Yes, and it is a genuine per-OS fork.** `tauri.conf.json:21` sets `decorations: false`, but `tauri.macos.conf.json` has no `decorations` key and sets `titleBarStyle: "Overlay"`, `hiddenTitle: true`, `transparent: true` (`:11-15`) — and platform config is "a JSON merge patch and the `windows` array is replaced whole rather than merged per key" (`drop.ts:10-12`). **So macOS runs a native overlay titlebar with real traffic lights and Windows/Linux run fully custom chrome.** Two mechanisms, and `Titlebar.tsx:3-12` records the AppKit-specific gutter problem. A screenshot per leg is the evidence | Whether it *looks* right is a design-reconciliation question (`assert-design.mjs`), not a verification one |
| **Installers: `.dmg` / `.msi` / `.AppImage`** | **No.** `#329` already settles this: "nothing about a `.dmg`, `.msi` or `.AppImage` is observable from a browser tab" | **No.** WebDriver drives a *running* app, not an installation. Mounting a dmg, running NSIS, the AppImage's self-replacement are all outside it — though scriptable separately, and `appimage-guard.sh` (`desktop.yml:155-156`) already asserts one property of the AppImage | Gatekeeper, SmartScreen, notarization, `webviewInstallMode: downloadBootstrapper` on a machine with no WebView2 (`tauri.conf.json:47-49`). None of it is reachable on a runner that already has WebView2 |

### The short version, for the skill's "cannot prove" section

**Chrome proves:** the React app, every row's frontend handling against mocks, the `?platform=`
branches in a dev build, and nothing whatsoever below `bridge.ts`. Eleven of the twelve bridge rows are
no-ops in it, and two of them — `save` and `loadArtifact` — are *different gestures* rather than absent
ones, which is worse than absent because a passing Chrome run looks like evidence.

**A real-binary WebDriver route adds:** `native`, window state and `zoom`/`minimize`, `canShoot`'s
three per-OS values, real `shoot` bytes, `loadArtifact`'s secure-context path, the CSP, platform
detection on three real webviews, the two titlebar mechanisms, window-state persistence across a
restart, and — the prize — a measured keychain round-trip on Windows and a measured
no-Secret-Service answer on Linux.

**Nothing automated here proves:** the native save sheet; a real OS file drop from Finder/Explorer;
that the system browser or a settings pane actually opened; the dock badge, taskbar overlay or tray
icon; an OS notification arriving; the updater end to end; installing from `.dmg`/`.msi`/`.AppImage`;
and the keychain's *refusal* cases (locked keyring, policy-closed Credential Manager, a macOS prompt
declined). Titlebar drag and the resize strips are **unknown and probably not drivable** — they hand
the pointer to the window server — and should be listed as unproven until a spike says otherwise.

Those are the rows a QA agent must never report as "verified".

---

## Recommendation

- **Home: `desktop.yml`**, as a job that `needs:` the build job. Three OSes, real bundler, warm caches,
  no secrets, and a comment in the file already asking for it.
- **Providers: `'official'` on Windows and Linux** — no plugin in the app, drives the real artifact,
  nothing shippable ever contains a server. **`'embedded'` on macOS**, because nothing else is free.
- **Gate: a non-default Cargo feature, not `cfg(debug_assertions)`**, because the thing to drive is a
  release-profile binary. Add a Doctor check that a default `tauri build` contains no wdio crate.
- **Not CrabNebula.** The paid macOS key does not buy back the ability to drive the shipped artifact —
  it still needs `tauri-plugin-automation` in the app.
- **Not a fleet machine**, for this. It cannot do Windows at all (`install/worker.sh:73`), is headless
  like a runner, and is one hand-maintained sample instead of three disposable ones. Keep it as the
  debugging affordance it is.
- **For #334:** the shell transport is **not** the same binary as the frontend one. The frontend
  transport is `playwright-core` driving Chrome, invoked in a session on one machine. The shell
  transport is a WebdriverIO run with a per-OS `driverProvider`, invoked by CI on three. They share
  selectors and conventions (`states.mjs`) and should share a feature map, but one is a library call
  and the other is a workflow leg. `control-firetower` should be able to *read* the shell transport's
  evidence and *say* what it does not cover; it should not pretend to launch it.

## What I could not establish

- Whether a Depot or GitHub macOS runner can host a rendering WKWebView well enough for the embedded
  provider. The Finder comment at `desktop.yml:158-159` is suggestive, not decisive. **Biggest open
  risk; spike it first.**
- Whether a `wdio:*` permission left in `capabilities/default.json` fails or silently no-ops a release
  build where the plugin was compiled out.
- The actual minutes a `--features wdio` second build adds. The +1–3 min figure is an estimate from the
  measured 34s/110s/140s bundle steps, not a measurement.
- Whether a WebDriver-synthesised pointer drag on the titlebar survives `startDragging()` handing the
  pointer to the window server. `drag.ts:33-38` suggests not.
- Whether a Firetower worker can launch a GUI app under `xvfb-run` through tmux over ssh. Expected to
  work; unmeasured.
- Whether `tauri-plugin-wdio-webdriver` needs anything in `entitlements.plist` on macOS.
