# Looking at the Linux build from a Mac

A Docker harness that builds the desktop application on Debian, installs it
from its own `.deb`, opens it under `Xvfb` + `openbox` and photographs it. It
exists because WebKitGTK's failure mode is a window that opens, reports no
error, and is blank or unstyled — so a build nobody looked at proves nothing,
and there is no Linux hardware here to look at it on.

```sh
desktop/linux/run.sh                 # build the image, then every phase
desktop/linux/run.sh build install   # or just those two
desktop/linux/run.sh --shell         # a prompt in the container
```

Output lands in `shots/` — screenshots, `facts.txt` with every measurement the
run made one per line, probe reports, and `logs/`. It is **not** in version
control: it is a megabyte of regenerable pictures that go stale the first time
the UI moves. `run.sh` overwrites rather than accumulates.

The phases are listed in [`check.sh`](check.sh)'s header, and any subset can be
run on its own; the cargo registry, the build directory, `node_modules` and the
pnpm store are named Docker volumes, so the second run does not pay for the
first one's downloads. A whole run is about fifteen minutes cold and nine warm,
on twelve arm64 cores.

## The two build dependencies that are on nobody's list

Tauri's published Linux prerequisites are not enough to build this
application, and neither error names anything recognisable:

* **`libdbus-1-dev`** — `keyring`'s `sync-secret-service` feature pulls
  `dbus-secret-service` → `dbus`, which links the C library through
  `pkg-config`. Without the package its build script is what fails.
* **`xdg-utils`** — the AppImage bundler copies `/usr/bin/xdg-open` into the
  AppDir and refuses to continue without it: `xdg-open binary not found`.
  `--bundles deb` does not care, so this only appears the moment you ask for
  the artifact the updater wants.

Both are in [`Dockerfile.check`](Dockerfile.check) and in the Linux leg of
`.github/workflows/desktop.yml`, which is the other place they have to be.

## Two things that look like Linux failures and are not

* **`tauri build --bundles deb` exits 1 after writing the `.deb`.** The
  committed config has `createUpdaterArtifacts: true` and a pubkey, and the
  private key only exists in the release pipeline. The bundle is already on
  disk when it happens. `--config src-tauri/unsigned.conf.json` is in the tree
  for exactly this; the CI leg passes it.
* **A stale `/tmp/.X99-lock`** survives a killed `Xvfb`, so the next run gets
  "server is already active", every launch then panics in `gtk::rt::init`, and
  all of it reads as a rendering failure. `check.sh` removes the lock and fails
  loudly if the display does not come up.

## The WebKitGTK floor

The frontend is Tailwind v4, whose emitted CSS needs registered custom
properties (`@property`, Safari 16.4 → **WebKitGTK 2.40**) and `color-mix()`
(Safari 16.2 → 2.38). A webview below that drops the rules silently, which is
the grey unstyled page this harness is looking for.

Nothing in reach is below it. Debian 12 carries 2.50.6 and Ubuntu 22.04 ships
2.50.4 through `jammy-updates`. The harness is on `debian:bookworm` and prints
the version it resolved — read it before trusting any screenshot. Pointing the
image at an older base is one line and turns this into a test of the engine
rather than of the application, which is a worthwhile separate run.

## What it can tell you, and what it cannot

**It can** answer whether the application builds, bundles, installs, launches,
paints and is styled; what `navigator`, `matchMedia`, `document.fonts` and the
stylesheet say from inside the real window (`probe.js`, appended to the page
for an instrumented build only); what the frameless window does when a pointer
drag, a window-manager resize or `startResizeDragging` is driven at it with
`xdotool`; and what the shell's own commands return over the real bridge. The
screenshots are measured — `mean`, `standard_deviation` and colour count on
every capture — so "the window went blank" is an assertion and not something a
human has to notice. An empty root window is `mean=0 sd=0 colours=1`.

**It cannot** tell you about anything that needs a desktop rather than a
window manager. There is no shell, no dock and no notification daemon in the
container, so a tray icon, a taskbar badge and a desktop notification have
nowhere to appear — what is measurable is that the calls return, not that
anybody sees them. There is no GPU and no `/dev/dri`, so every renderer
question is answered under llvmpipe and says little about the DMA-BUF bugs
that only appear on real drivers. The daemon here is arm64, so the packages it
builds are arm64; x86_64 packaging is CI's job. And `bwrap` cannot create a
namespace under Docker's default policy, so anything about the WebKit
subprocess sandbox has to be measured in a `--privileged` container and is
still not a measurement about a real machine.

`gnome-keyring` is deliberately **not** installed: the keychain question is
what happens with no Secret Service on the bus, which is a minimal desktop or
an ssh session, and installing one would answer a question nobody asked.
