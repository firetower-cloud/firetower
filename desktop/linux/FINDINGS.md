# Does Firetower render on Linux, and can that be checked from a Mac?

**Yes, and yes.** The desktop application builds unmodified on Debian bookworm,
installs from its own `.deb`, opens a window under `Xvfb` + `openbox`, connects
to a control plane and draws the whole product — rail, workspace panel, ember
dots, composer, agent chips, avatars, artifact posters, Archivo — with nothing
unstyled and nothing blank. The harness that proves it is five files in this
directory and runs on a Mac with Docker and no Linux hardware at all.

What follows is what broke, what degrades, and what is already fine. Every
number here came out of a run; the screenshots are in [`shots/`](shots/) and
the transcripts in [`shots/logs/`](shots/logs/).

> **This is a spike, not the port.** Nothing outside `desktop/linux/` was
> changed, `tauri.conf.json`'s committed bundle targets are untouched, and the
> Linux targets were passed on the command line. **No source change was
> required to build** — that is itself the first finding.

## What was run

| | |
|---|---|
| Host | Apple Silicon Mac, Docker 29.4.0 (OrbStack), daemon **arm64** |
| Image | `debian:bookworm` (12.15), **linux/arm64**, native — not emulated |
| WebKitGTK | **2.50.6** (`libwebkit2gtk-4.1-0 2.50.6-1~deb12u2`) |
| GTK / libsoup / glib | 3.24.38 / 3.2.3 / 2.74.6 |
| Toolchain | rustc 1.90.0, node v22.23.4, pnpm 10.34.9 |
| Display | Xvfb 1440x900x24, openbox 3.6.1, Mesa **llvmpipe** 22.3.6, no `/dev/dri` |
| App | `firetower-desktop` 0.29.0, tauri 2.11.5, wry 0.55.1, tao 0.35.3 |

```sh
desktop/linux/run.sh          # the whole thing
desktop/linux/run.sh build    # or one phase; see check.sh's header
```

## The nine checks, at a glance

| | verdict | |
|---|---|---|
| **Blank window** (WebKitGTK DMA-BUF) | **works** | Renders in all four launch configurations, identically. `WEBKIT_DISABLE_DMABUF_RENDERER=1` changed nothing — but there is no GPU here, so this is weak evidence about the bug and strong evidence about the app. [→](#the-dma-buf-renderer--not-needed-here-and-here-is-not-everywhere) |
| **Tailwind v4 CSS** | **works** | WebKitGTK **2.50.6**. All 73 emitted `@property` rules parsed as `CSSPropertyRule`; `color-mix()`, `oklch()`, relative colours, nesting, `:has()` all supported. The app emits **no** `oklch()` at all. [→](#tailwind-v4--every-feature-supported-every-rule-parsed) |
| **Frameless window — drag** | **works** | `startDragging()` moves it; double-click maximises. [→](#window-dragging-minimum-size-and-the-chrome-generally) |
| **Frameless window — resize** | **broken** | No frame, no grip, no edge to grab. The window *is* resizable — the WM can do it, the 880x560 minimum is enforced — there is simply no affordance. [→](#2-a-frameless-window-cannot-be-resized-by-dragging-its-edge) |
| **Platform detection** | **works** | `userAgentData` is `undefined`; `navigator.platform` is `"Linux aarch64"`; `dataset.platform` ends up `"linux"`. [→](#platform-detection-falls-through-correctly) |
| **Fonts** | **works** | All three local woff2 faces load; Archivo is measurably the one in use — 423.6px against the fallback's 489.97px for the same string. [→](#fonts--all-three-load-and-archivo-is-measurably-the-one-in-use) |
| **Keychain** | **broken** | `Platform secure storage failure: DBus error: The name org.freedesktop.secrets was not provided by any .service files` — swallowed, so you are silently signed out on every restart. [→](#1-no-secret-service-means-you-sign-in-again-on-every-launch-silently) |
| **Tray and badge** | **not built / no-op** | No tray is compiled on Linux at all. The badge call returns `Ok` and does nothing — tao requires `libunity` *and* a running Unity session. Measured: the no-op. Read from source: why. [→](#tray-not-built-and-three-of-trayrss-four-calls-are-linux-no-ops) |
| **Artifact capture** | **confirmed stub** | Linux compiles to `SUPPORTED = false`, verified by the error string from the real window. `webkit_web_view_get_snapshot()` is viable and is the *cheapest* of the three implementations. [→](#artifact-capture-not-built-and-the-linux-implementation-is-the-cheap-one) |
| **Updater** | **premise is out of date** | Tauri 2.11 installs `.deb` and `.rpm` too — but through `pkexec dpkg -i`, so every update asks for a password. Only the AppImage updates silently. Both artifacts were built and the AppImage was run. [→](#which-linux-package-we-should-recommend--and-the-updater-premise-is-out-of-date) |

And two things the brief did not ask about but that somebody has to decide:
**the theme a fresh Linux install opens in**
([→](#the-theme-default-is-inconsistent-across-platforms)) and **which package
we tell people to download**
([→](#which-linux-package-we-should-recommend--and-the-updater-premise-is-out-of-date)).

## Blockers

Things that would make the application unusable, wrong-looking, or
embarrassing if a Linux build shipped as it stands.

### 1. No Secret Service means you sign in again on every launch, silently

**Broken.** This is the one that would generate support tickets.

`main.rs`'s `secret_set` goes through `keyring` 3.6.3 →
`dbus-secret-service` 4.1.0 → `org.freedesktop.secrets`. On a box with no
`gnome-keyring` / `kwallet` — a minimal desktop, a tiling WM, anything over
ssh, and this container — that name is not on the bus at all:

```
$ dbus-send --session --dest=org.freedesktop.secrets ...
Error org.freedesktop.DBus.Error.ServiceUnknown:
  The name org.freedesktop.secrets was not provided by any .service files
```

**What `secret_set` returns**, invoked from the real window through the same
bridge the application uses — all three commands, verbatim:

```
secret_set     Platform secure storage failure: DBus error:
               The name org.freedesktop.secrets was not provided by any .service files
secret_get     (the same string)
secret_delete  (the same string)
```

Note `secret_get` **errors** rather than answering `Ok(None)`. It never
reaches `main.rs`'s `Err(keyring::Error::NoEntry) => Ok(None)` arm, because
the failure is the bus, not a missing entry.

What the application does with that is the problem. `src/servers.ts`:

```ts
// remember()
if (kc) {
  tokens.set(server.serverId, server.token);
  void kc.set(server.serverId, server.token).catch(() => {});   // swallowed
}
write([...rest, server]);

// write()
window.localStorage.setItem(KEY, JSON.stringify(kc ? list.map((s) => ({ ...s, token: "" })) : list));
```

The keychain write fails, the rejection is discarded, and `write()` *still*
strips the token out of `localStorage` because a keychain exists as an
interface even though it does not work. The in-memory `tokens` map carries the
session, so **signing in appears to work perfectly**. On the next launch
`hydrate()` finds nothing in the keychain and an empty `token` in the
registry, and the person is back at the password field — with the server still
listed, their name still in the title bar, and no message anywhere saying why.

Driven end to end: [`shots/connect-4-signed-in.png`](shots/connect-4-signed-in.png)
is the dashboard after signing in to the mock control plane;
[`shots/app-dark-after-restart.png`](shots/app-dark-after-restart.png) is the
same application restarted with nothing else changed — *"Who are you here?"*,
Acme still remembered, token gone.

Not building a fallback was the instruction, so this only records the failure
mode. Three plausible answers for whoever does fix it: fall back to
`keyring`'s `linux-native` feature, which is the kernel keyring and therefore
does not survive a reboot; keep an encrypted file of our own, which is a
decision about threat model rather than a patch; or — the cheapest honest
one — **stop discarding the error**, so the sign-out comes with a sentence
saying there is no keyring on this machine. The third is worth doing whatever
else is chosen, because today the only symptom is an app that forgets you.

### 2. A frameless window cannot be resized by dragging its edge

**Broken.** Dragging works; resizing does not.

`tauri.conf.json` sets `decorations: false` and openbox honours it exactly —
`_MOTIF_WM_HINTS(_MOTIF_WM_HINTS) = 0x2, 0x0, 0x0, 0x0, 0x0` is
`MWM_HINTS_DECORATIONS` with every decoration bit clear, and `xwininfo`
reports `Border width: 0`. There is no frame, so there is no edge to grab, and
GTK draws no client-side resize grip of its own when `decorated` is false.

Measured four ways, on the same window:

| | result |
|---|---|
| Drag the title bar at +520+18 (`drag.ts` → `startDragging()`) | **works** — `+79+27` → `+239+127` |
| Drag the bottom-right corner | **nothing** — `1280x820` → `1280x820` |
| `xdotool windowsize 1000 700` (the WM resizing it) | **works** — `1000x700` |
| `xdotool windowsize 400 300` | **clamped to `880x560`**, the configured minimum |

So the window *is* resizable — `_NET_WM_ALLOWED_ACTIONS` lists
`_NET_WM_ACTION_RESIZE` and `WM_NORMAL_HINTS` carries the 880x560 minimum with
no maximum. There is simply no affordance. A person on openbox can still
resize with the WM's own keybinding (`Alt+F8`) or a modifier-drag, and most
desktops have some equivalent — but **nobody discovers that**, and a window
that cannot be made smaller than the size it opened at is the kind of thing
that reads as broken.

**The two ways out, for whoever takes this decision.** They are not
equivalent and the choice is a design one, not a technical one.

**(a) Draw the grips in the React chrome.** Eight transparent strips — four
edges at ~4px, four corners at ~12px — positioned `fixed` around the window
at a `z-index` above the content, each calling
`getCurrentWindow().startResizeDragging(d)` from `@tauri-apps/api/window`,
where `d` is one of the eight `ResizeDirection` strings
(`'SouthEast'`, `'North'`, …). That method is in the copy of
`@tauri-apps/api` this app already depends on —
`startResizeDragging(direction: ResizeDirection): Promise<void>` at
`window.d.ts:1096` — and maps to `gtk_window_begin_resize_drag`, so there is
no Rust to write and no config to change. Cost: one new component of roughly
forty lines plus a `cursor` rule per direction, mounted next to
`Titlebar.tsx`. The hazards are the ones every
frameless app meets — the strips must not eat clicks meant for content near
the edge (they are outside the layout, so they will not), and on macOS they
have to be suppressed or they fight AppKit's own resize margin, which means
one `platform !== "macos"` guard. **This keeps the design and is the answer
if the custom chrome matters**, which `STYLE.md` says it does.

**(b) Turn decorations back on for Linux only.** A `tauri.linux.conf.json`
beside `tauri.macos.conf.json` with `decorations: true`, selected the same way
the macOS override already is. Cost: about six lines of JSON, and nothing
else — until you look at it. The system title bar then sits *above*
Firetower's own, which is two title bars stacked, and `Titlebar.tsx`'s
`{!isMac && bridge.native && ...}` branch would have to become
`{isWindows && ...}` so the custom minimise/maximise/close are not drawn
twice. The result is a window that resizes like every other window on the
desktop and looks like a web page in a frame. **This is the cheap answer and
it costs the chrome.**

There is a third thing worth knowing, because it changes how urgent this is:
double-click to maximise already works — `drag.ts`'s `onDoubleClick` calls
`toggleMaximize()` — so the window is not stuck at one *size*, only at one
*shape*. Somebody can get a full-screen Firetower today; they cannot get a
narrow one.

## Degrades

Works, but less than it does on macOS or Windows. None of these stops anybody
using the application.

### Tray: not built, and three of `tray.rs`'s four calls are Linux no-ops

`src-tauri/src/tray.rs` is `#![cfg(target_os = "windows")]` and the
`tray-icon` feature is asked for only in the Windows dependency block, so the
Linux build **does not compile a tray at all** — `grep -c "Compiling tray-icon"`
over the build log is `0`, while `muda` (the menu crate it shares) is built.
`libappindicator 0.9.0` is in `Cargo.lock` but is never reached.

Tauri v2 *can* do a tray on Linux, through `tray-icon` 0.24 →
`libayatana-appindicator3` (the `-dev` package is already in the harness
image). What it cannot do is most of what `tray.rs` asks for. From
`tray-icon`'s own documentation and its `platform_impl/gtk` source:

| `tray.rs` writes | on Linux |
|---|---|
| `.tooltip("Firetower")` | **Unsupported.** Documented as such. |
| `.show_menu_on_left_click(false)` | **Unsupported.** `menu_on_left_click` is documented "Linux: Unsupported". |
| `.on_tray_icon_event(... MouseButton::Left ...)` → `raise()` | **Never fires.** `platform_impl/gtk/` contains no `TrayIconEvent` emission at all — AppIndicator delivers a menu, not clicks. |
| `.on_menu_event("open" / "quit")` | **Works.** This is the only channel. |
| `waiting()` → `set_icon` | **Works**, with a caveat: an AppIndicator icon is written to a temp file and re-read, so swapping it often is heavier than on Windows. |

So a Linux tray is possible and would cost: a `tauri = { features = [...,
"tray-icon"] }` entry in a `cfg(target_os = "linux")` block, dropping the
`#![cfg(windows)]` from `tray.rs`, and **rewriting `raise()` to hang off a
menu item rather than a left click** — the interaction that is the point of
the Windows tray does not exist on this platform. And an AppIndicator only
shows up at all on a desktop running a StatusNotifierItem host, which GNOME
famously does not ship by default. **I could not test any of that here** —
there is no desktop shell in this container, only a window manager — so treat
the "would cost" as a plan and not a measurement. The argument for leaving the
tray off on Linux is the same one `tray.rs` already makes for the Mac: it is
ambient status on a platform that may have nowhere to put it.

### Badge: the call succeeds and does nothing on almost every desktop

`set_badge` invoked from the real window returns `Ok` — no error, no panic.
It also does nothing, and tao says why. `tao-0.35.3/src/platform_impl/linux/`:

```rust
// window.rs
pub fn set_badge_count(&self, count: Option<i64>, desktop_filename: Option<String>)
  → WindowRequest::BadgeCount → TaskbarIndicator::update_count

// taskbar.rs
Container::load("libunity.so.4").or_else(…so.6).or_else(…so.9)
…
if !self.is_unity_running() { return; }          // unity_inspector_get_unity_running
…
unity_launcher_entry_set_count(entry, count)
unity_launcher_entry_set_count_visible(entry, true)
```

Two gates, and the second is the one that matters. `libunity.so` has to be
present to `dlopen`, **and `unity_inspector_get_unity_running()` has to return
1** — that is, the running session has to be Unity, a desktop essentially
nobody runs now. Neither gate was met here (no `libunity` in the image), so
what I measured is that the call returns `Ok` and nothing happens; the *reason*
is read out of tao's source. Either way, on a current desktop the badge is a
silent no-op.

One thing is right, at least: Tauri passes
`format!("{}.desktop", package_info().name)` as the launcher id, which is
`Firetower.desktop`, and that is exactly the filename the `.deb` installs. If
this is ever pursued, the id matches; the mechanism is what does not.

The route that does not depend on Unity is to emit the
`com.canonical.Unity.LauncherEntry` D-Bus signal directly — the same signal
`libunity` sends, which several dock and taskbar implementations listen for —
from `set_badge` under a `cfg(target_os = "linux")`. That is tens of lines of
`dbus`, which is already a dependency. **Untested here**: there is no dock in
this container to receive it, so whether any given desktop picks it up is a
question for real hardware.

### Artifact capture: not built, and the Linux implementation is the cheap one

**Confirmed empirically.** `capture_poster` invoked from the real Linux window
answers:

```
photographing an artifact is not built on this platform
```

which is `capture.rs`'s `#[cfg(not(any(target_os = "macos", windows)))]` stub
verbatim, so Linux does compile to that branch. The build also warns about
it — `warning: constant POSTER is never used, src/capture.rs:38` — because the
stub is the one `platform` module that never reads the downscale width. That
warning is Linux-only and would fail a `-D warnings` job.

**`webkit_web_view_get_snapshot()` is a viable implementation and it is the
easiest of the three.** The pieces are already in the tree:

* `tauri::webview::PlatformWebview::inner()` on Linux returns a
  **`webkit2gtk::WebView`** — a typed, safe Rust object, not a raw pointer the
  way macOS and Windows hand one back;
* `webkit2gtk` 2.0.2 (already a transitive dependency, already compiled)
  exposes
  `snapshot(SnapshotRegion, SnapshotOptions, Option<&Cancellable>, impl FnOnce(Result<cairo::Surface, glib::Error>))`;
* the result is a `cairo::ImageSurface`, which has `write_to_png` built in.

So the whole Linux arm is roughly: call `snapshot` with
`SnapshotRegion::Visible`, take the `cairo::Surface`, downscale from the
1180pt layout to the 420pt poster — `image` 0.25 is already a dependency on
Windows for exactly this and would move to a shared block — and write PNG.
**Call it 40–60 lines and no `unsafe`**, against the ~90 lines of `msg_send!`
the macOS arm needs. The one genuine difference is that `get_snapshot`
captures the *visible region* rather than taking a `snapshotWidth`, so the
scaling is ours, which is the same shape the Windows arm already has.

### The `.desktop` entry is minimal, and has no category

What the `.deb` installs, verbatim:

```ini
[Desktop Entry]
Categories=
Comment=Firetower, as a desktop application
Exec=firetower-desktop
StartupWMClass=firetower-desktop
Icon=firetower-desktop
Name=Firetower
Terminal=false
Type=Application
```

`Categories=` is present and empty. It still **validates** —
`desktop-file-validate` on this exact file exits 0 with nothing to say, so
that part of my first reading was wrong — but an entry with no category is an
entry that application menus which group by category file under "Other".
`bundle.category` in `tauri.conf.json` is unset, which is why the bundler
emitted the key with nothing in it; `"Development"` is one line of JSON and
costs macOS and Windows nothing.

`StartupWMClass` is right — the window reports
`WM_CLASS(STRING) = "firetower-desktop", "Firetower-desktop"`, so the taskbar
groups the window under the right icon. Three icon sizes are installed
(`32x32`, `128x128`, `256x256@2`), which comes straight from the
`bundle.icon` list; most desktops also want a `256x256` or `512x512` and will
upscale the 128 instead. Cosmetic, but visible in an app grid.

Also: the binary on `$PATH` is **`firetower-desktop`**, not `firetower`,
because the deb takes it from the Cargo package name. If the command people
type matters, `mainBinaryName` is where that is set.

### Notifications go nowhere without a notification daemon, silently

`notify` returns `Ok` and nothing appears. `main.rs` writes
`let _ = app.notification()…show()`, so the error is discarded the same way
the keychain's is, and `org.freedesktop.Notifications` is simply not on the
bus in a bare session. On a real desktop it will be there; over ssh or in a
container it will not. Lower stakes than the keychain — a missing toast is not
a lost credential — but it is the same pattern and worth knowing about.

### Launching with no `DISPLAY` panics rather than explaining

```
thread 'main' panicked at tao-0.35.3/src/platform_impl/linux/event_loop.rs:217:53:
Failed to initialize gtk backend!: BoolError { message: "Failed to initialize GTK",
  filename: "gtk-0.18.2/src/rt.rs", function: "gtk::rt::init", line: 141 }
```

That is what the application does when GTK cannot reach a display. I hit it
through a stale `/tmp/.X99-lock`; a user hits it by running
`firetower-desktop` over an ssh session with no X forwarding. The panic is
tao's, not ours, and there is nothing to fix in this repository — recorded
because it is the first thing a confused user will paste into an issue, and
it says nothing about displays.

## Fine

Each of these was a suspected risk and each one is simply not a problem on
this configuration.

### The build, unmodified

**No source change was needed.** `pnpm tauri build --bundles deb` on a clean
checkout compiles 383 crates and produces
`Firetower_0.29.0_arm64.deb` (8.5 MB), which `apt install` takes without a
missing dependency — `ldd /usr/bin/firetower-desktop | grep -c "not found"`
is `0`. The per-target dependency blocks in `Cargo.toml` do the right thing by
omission: macOS gets `window-vibrancy`/`objc2`, Windows gets
`webview2-com`/`windows`, and Linux gets neither and needs neither.

One warning, Linux-only, and it is a true one:

```
warning: constant `POSTER` is never used
  --> src/capture.rs:38:7
```

The capture stub is the only `platform` module that does not read the
downscale width. Harmless today; it would fail a `-D warnings` job, and it
goes away the moment a Linux `capture.rs` exists.

`libdbus-1-dev` is required and is **not** on Tauri's published Linux
dependency list: `keyring`'s `sync-secret-service` feature pulls
`dbus-secret-service 4.1.0` → `dbus 0.9.12`, which links the C library. The
build log shows `Compiling dbus v0.9.12` right after `tauri-build`, which is
the evidence — I never removed the package to watch it fail.

`libssl-dev` turned out **not** to be needed — `openssl-sys` is not in
`Cargo.lock` at all, because `reqwest` is pinned to `rustls-tls`. It is
installed in the harness anyway, since it is on Tauri's list and costs
nothing, but it is not load-bearing here.

### It renders, in every configuration tried

Four launches of the installed `.deb`, all identical, all 1280x820, none
blank:

| launch | window mean / sd | distinct colours | |
|---|---|---|---|
| default | 250.66 / 22.46 | 649 | [`window-default.png`](shots/window-default.png) |
| `WEBKIT_DISABLE_DMABUF_RENDERER=1` | 250.65 / 22.55 | 684 | [`window-nodmabuf.png`](shots/window-nodmabuf.png) |
| `WEBKIT_DISABLE_DMABUF_RENDERER=1 LIBGL_ALWAYS_SOFTWARE=1` | 250.65 / 22.53 | 684 | [`window-nodmabuf-softgl.png`](shots/window-nodmabuf-softgl.png) |
| `WEBKIT_DISABLE_COMPOSITING_MODE=1` | 250.65 / 22.55 | 684 | [`window-compositing-off.png`](shots/window-compositing-off.png) |

For scale, the empty root window before launch
([`root-empty-desktop.png`](shots/root-empty-desktop.png)) is `mean=0 sd=0
colours=1` — that is what blank actually looks like here, and nothing
produced it.

The application was then driven through the whole first-run flow with
`xdotool` against `scripts/mock-server.mjs` and photographed at each step:

| | |
|---|---|
| [`connect-1-address.png`](shots/connect-1-address.png) | the address typed into the first-run field |
| [`connect-2-found.png`](shots/connect-2-found.png) | *Acme · localhost:4401 · 0.34.1* — `/api/v1/bootstrap` reached over plain http from the webview |
| [`connect-3-credentials.png`](shots/connect-3-credentials.png) | username and password |
| [`connect-4-signed-in.png`](shots/connect-4-signed-in.png) | **the dashboard** — rail, workspace panel with ember dots, composer, agent chips, artifact posters |
| [`app-rail-4.png`](shots/app-rail-4.png) | Customize → Skills: the amber callout with its brick rule, avatars, version badges, dot markers, search field |
| [`app-rail-2.png`](shots/app-rail-2.png) | Tasks: issue rows, state glyphs, labels, and the query line in **JetBrains Mono** |
| [`app-rail-1.png`](shots/app-rail-1.png), [`app-rail-5.png`](shots/app-rail-5.png) | two more destinations |
| [`window-gtk-dark.png`](shots/window-gtk-dark.png) | the same build in the dark branch |

Nothing is unstyled, nothing is missing, nothing fell back to a system font.
This is the answer to the question on the issue.

### The DMA-BUF renderer — not needed here, and here is not everywhere

`WEBKIT_DISABLE_DMABUF_RENDERER=1` changed nothing: same screenshots, and the
probe's page report is **byte-identical** with and without it.

**Be careful how much weight this carries.** The container has no `/dev/dri`,
so Mesa falls back to `llvmpipe` (22.3.6, `Accelerated: no`) and WebKitGTK's
DMA-BUF path is unlikely to have been exercised at all. This run is strong
evidence that *nothing in Firetower* trips the bug, and weak evidence about
the bug itself — which, as the brief puts it, happens "on some GPUs and in
VMs", i.e. it is a driver-and-compositor interaction and there is neither here.
A real GPU cannot be reached from a container on a Mac; that needs one Linux
box with a GPU, or a CI runner with one, and it is the one question this
harness cannot answer.

A gotcha for anybody who tries to diagnose this from inside the page: the
webview reports `WEBGL_debug_renderer_info` as **vendor "Apple Inc.",
renderer "Apple GPU"** on Linux — WebKit masks those strings — while
`glxinfo -B` in the same container says `llvmpipe (LLVM 15.0.6)`,
`Accelerated: no`. The page cannot tell you what it is drawing on.

**If it ever is needed**, the two ways to set it are not equivalent:

* **`.desktop` `Exec` line.** `bundle.linux.deb.desktopTemplate` takes a
  Handlebars template, so `Exec=env WEBKIT_DISABLE_DMABUF_RENDERER=1 {{exec}}`
  is about five lines of config plus a template file. It only covers launches
  *from the desktop menu* — a terminal launch, and the AppImage, are unaffected.
* **`std::env::set_var` in `main()`.** One line before `tauri::Builder`, which
  is before GTK is initialised, so it covers every launch path including the
  AppImage. The crate is edition 2021, so the call is still safe (it becomes
  `unsafe` in edition 2024). This is the right answer if it is ever needed,
  and it should be conditional — forcing software compositing on hardware that
  works is a real cost.

### Tailwind v4 — every feature supported, every rule parsed

WebKitGTK **2.50.6** — two stable series past the 2.46 the brief names as the
first with `@property`. The emitted stylesheet, and what the engine made of
it:

| | in `dist/assets/index-*.css` | parsed in the live document |
|---|---|---|
| `@property` | 73 | **73 `CSSPropertyRule`** |
| `color-mix()` | 84 | — |
| `oklch()` | 0 | — |
| `@font-face` | 3 | 3 `CSSFontFaceRule` |
| total | 134,135 bytes | 1,635 `CSSStyleRule`, 44 `CSSSupportsRule`, 21 `CSSMediaRule`, 16 `@keyframes`, 5 `@layer`, **0 unreadable sheets** |

`CSS.supports()` from inside the window: `oklch` ✅, `color-mix(in oklab, …)` ✅,
`CSS.registerProperty` ✅, relative colours `rgb(from red r g b)` ✅, `&`
nesting ✅, `:has()` ✅, `backdrop-filter` ✅, container queries ✅.

Worth noting for the risk register: **the app emits no `oklch()` at all.** Its
palette is hex, declared in `@theme`, so even an engine without `oklch` would
colour correctly. The actual exposure is `color-mix()` (84 uses) and
`@property` (73) — both of which this engine has. An engine old enough to
lack them is where the grey page would come from, and finding the floor is
one line of `Dockerfile.check` and a run I did not do.

### Platform detection falls through correctly

`navigator.userAgentData` is `undefined` — WebKitGTK does not implement it, as
expected — so `platform.ts`'s `?? navigator.platform` is what answers:

```
navigator.userAgent  Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/605.1.15
                     (KHTML, like Gecko) Version/60.5 Safari/605.1.15
navigator.platform   "Linux aarch64"
navigator.vendor     "Apple Computer, Inc."
userAgentData        undefined
```

`"linux aarch64"` contains neither `mac` nor `win`, so `detect()` returns
`"linux"` by its final `return` — and `"linux x86_64"` would too, so the arm64
caveat that applies to packaging does not apply here. Read back off the live document,
`document.documentElement.dataset.platform` is **`"linux"`** — that is
`platform.ts`'s own verdict, not a re-derivation of it. So `mod` is `Ctrl`,
`localMod` is `Alt`, and `isMac` is false, which is what the title bar and
every shortcut need.

One thing to be aware of rather than fix: `navigator.vendor` says *"Apple
Computer, Inc."* on Linux, because WebKitGTK is WebKit. Anything that ever
sniffs vendor instead of platform will get this wrong; nothing in the app
does today.

### Fonts — all three load, and Archivo is measurably the one in use

Asked for explicitly with `document.fonts.load()` rather than waiting for a
screen that happens to use them, so the answer is about the files and not
about which route the probe landed on:

| face | `load()` resolved with | `document.fonts` status | `check()` |
|---|---|---|---|
| Archivo (100–900) | 1 face | **loaded** | true |
| Archivo Narrow (100–900) | 1 face | **loaded** | true |
| JetBrains Mono (100–800) | 1 face | **loaded** | true |

A `load()` that resolves with a face is a woff2 that was fetched over
`tauri://localhost` and parsed. A missing or corrupt file resolves with an
empty list. All three are fine.

`check()` can answer true for a family the engine would synthesise, so for the
proportional faces the widths settle it. The same string at 32px:

```
Archivo           423.60
Archivo Narrow    352.00
sans-serif        489.97
DejaVu Sans       489.97     ← the system fallback, identical to sans-serif
```

Archivo is 66px narrower than the fallback over one sentence; had the webfont
failed, those two numbers would be identical. `--font-sans` resolves to
`"Archivo", ui-sans-serif, system-ui, sans-serif` and the computed
`body { font-family }` is `Archivo, …`, so the face that loaded is the face in
use.

**The width test cannot do the same for the monospace** — JetBrains Mono
measures 570.00 and so does generic `monospace`, because the system's mono
fallback has nearly the same advance width and that is what being monospace
means. `load()` resolving is the evidence there. It is also visible:
[`shots/app-rail-2.png`](shots/app-rail-2.png) has the Tasks query line
(`label:bug sort:updated-desc`) set in it.

### Window dragging, minimum size, and the chrome generally

The frameless window is genuinely frameless — `_MOTIF_WM_HINTS` with every
decoration bit clear, `Border width: 0` — so what you see at the top of every
screenshot is `Titlebar.tsx`, drawn by React, including the
minimise/maximise/close glyphs on the right. openbox adds nothing.

* **Drag** works. `drag.ts` → `startDragging()` → `gtk_window_begin_move_drag`:
  `+79+27` → `+239+127` after a synthetic press-move-release on the bar.
* **Double-click to maximise** works (`toggleMaximize()`).
* **The configured minimum is enforced by the window, not by the app.**
  `WM_NORMAL_HINTS` carries `minimum size: 880 by 560`, and asking the WM for
  `400x300` gets `880x560`. The `minWidth`/`minHeight` in `tauri.conf.json`
  reach Linux correctly.
* **`WM_CLASS`** is `"firetower-desktop", "Firetower-desktop"`, matching the
  `.desktop` file's `StartupWMClass`, so the window groups under its own icon.

### Networking and the CSP

The webview reaches a control plane over plain `http` from the
`tauri://localhost` origin — `/api/v1/bootstrap`, `/auth/login` and the whole
dashboard's reads all went through. The committed CSP needed no Linux-specific
relaxation.

**The origin on Linux is `tauri://localhost`** — the webview's localStorage
file is `tauri_localhost_0.localstorage`, which settles it — and that is
already the first entry in `probe.ts`'s `PACKAGED_ORIGINS`, so a control
plane's allowlist needs nothing new for this platform.

One thing the harness learnt the hard way and is worth writing down anyway:
that origin makes the page a **secure context** (`isSecureContext: true`) and
makes every request it sends **cross-origin**, so anything it talks to has to
answer `OPTIONS` as well as send `access-control-allow-origin`.
`scripts/mock-server.mjs` does; the probe's own collector did not, and three
runs went by with WebKit reporting only `TypeError: Load failed`. If a
networking bug is ever reported from any platform, check the preflight before
anything else.

## Two decisions to take, rather than defects to fix

### The theme default is inconsistent across platforms

**This is not a rendering bug and the light theme is not a fallback.**
`globals.css` keeps every dark value as the default and puts light behind
`[data-theme="light"]`, deliberately and at length; `theme.ts` defaults the
preference to `"system"`, resolves it through `prefers-color-scheme`, and
writes the attribute. All of that worked exactly as designed on Linux, and the
light screenshots are the light theme being correct.

What differs is the **out-of-the-box appearance for somebody who has chosen
nothing**, and it differs because `tauri.conf.json`'s `"theme": "Dark"` does
not reach the Linux webview.

Measured, same binary, GTK the only variable:

| | `prefers-color-scheme: dark` | `: light` | `: no-preference` | `dataset.theme` | `color-scheme` | `--color-ground` |
|---|---|---|---|---|---|---|
| no `GTK_THEME` (the image's default) | `false` | **`true`** | `false` | **`light`** | `light` | `#f2f2f3` |
| `GTK_THEME=Adwaita` | `false` | **`true`** | `false` | **`light`** | `light` | `#f2f2f3` |
| `GTK_THEME=Adwaita:dark` | **`true`** | `false` | `false` | **`dark`** | `dark` | `#1d1d1e` |

Side by side: [`shots/window-gtk-light.png`](shots/window-gtk-light.png) and
[`shots/window-gtk-dark.png`](shots/window-gtk-dark.png) — the same first-run
screen, `mean=250.7` against `mean=38.4`.

Note the first two rows are the same: **a desktop that has expressed no
preference answers `light`, not `no-preference`**, so `theme.ts`'s
`prefersLight()` is true and `resolve("system", true)` returns `light`. There
is no third state to branch on.

`localStorage["firetower.theme"]` was `null` in all three — nobody had chosen,
so all three are the `"system"` path. `--color-ground` resolving to `#1d1d1e` rather
than `globals.css`'s `#0b0b0c` is correct too: it is `styles.css`'s
`[data-theme="dark"]` override, the desk's own dark ground, which means the
whole attribute chain works on Linux end to end.

**Why the config key does not reach it.** `tao-0.35.3`'s Linux window ignores
the `preferred_theme` it is given and reads the desktop portal instead
(`src/platform_impl/linux/window.rs:196-206`):

```rust
// Set initial `preferred_theme` value to current portal color-scheme
#[cfg(feature = "dbus")]
let preferred_theme = super::portal::theme().ok();     // org.freedesktop.appearance
#[cfg(not(feature = "dbus"))]
let preferred_theme = None;

if let Some(theme) = preferred_theme {
  if let Some(settings) = Settings::default() {
    settings.set_gtk_application_prefer_dark_theme(theme == Theme::Dark);
  }
}
```

`attributes.preferred_theme` — which is where `"theme": "Dark"` lands — is
never read on this platform. So on macOS and Windows a user whose system is in
light mode still gets dark Firetower; on Linux the same user gets light
Firetower. **One build, one `"system"` setting, two appearances.**

**Can anything in Tauri v2 force it on Linux?** Yes, two things, and neither is
a config key:

* **`window.set_theme(Some(Theme::Dark))` at runtime.** Unlike the builder
  attribute, `tao`'s Linux `set_theme` *is* implemented: it sends
  `WindowRequest::SetTheme`, which sets `gtk-application-prefer-dark-theme`,
  which is what WebKitGTK answers `prefers-color-scheme` from. One line in
  `main.rs`'s `setup()` under `#[cfg(target_os = "linux")]`, and it should
  make Linux match the Mac exactly. **Read out of the source, not measured** —
  proving it needs a patched build, which was outside this spike.
* **Set the GtkSettings property directly**, same effect, more code. No reason
  to prefer it.

A `tauri.linux.conf.json` with `"theme": "Dark"` would **not** work, and that
is the trap worth recording — it looks like the obvious fix and it is a no-op.

**The decision.** Three defensible answers and they are genuinely different
products:

1. **Match the other platforms** — `set_theme(Dark)` on Linux, so a fresh
   install is dark everywhere. One line, and the most consistent.
2. **Make the whole app follow the system** — drop `"theme": "Dark"` from
   `tauri.conf.json` so macOS and Windows also honour `"system"`, which is what
   `theme.ts` already says it wants. Larger change in effect, truer to the
   design of `theme.ts`, and it means some Mac users see a light Firetower for
   the first time.
3. **Leave Linux following the desktop** — defensible on a platform where
   respecting the desktop's appearance is a strong convention, but it should
   be written down rather than being an accident of what `tao` does.

Either way: `theme.ts` needs no change, and whatever is chosen should also
watch the portal's `SettingChanged` signal, which `tao` already forwards, so a
desktop flipping to dark at dusk moves Firetower with it.

### Which Linux package we should recommend — and the updater premise is out of date

**The brief says Tauri's updater on Linux only supports AppImage. That is not
what the version in this tree does.** Read out of
`tauri-plugin-updater-2.11.0/src/updater.rs` — the version `Cargo.lock`
resolves:

```rust
fn install_inner(&self, bytes: &[u8]) -> Result<()> {
    match installer_for_bundle_type(bundle_type()) {
        Some(Installer::Deb) => self.install_deb(bytes),
        Some(Installer::Rpm) => self.install_rpm(bytes),
        _ => self.install_appimage(bytes),
    }
}
```

`bundle_type()` reads a marker the bundler stamps into the binary — the build
log literally says `Patching … with bundle type information: deb` — so a `.deb`
build knows it is a `.deb` and takes the `.deb` path. And in the bundler,
`Deb` and `Rpm` are in `has_self_contained_target`, so `createUpdaterArtifacts:
true` is satisfied by the `.deb` itself with no `.tar.gz` wrapper; only
AppImage/app/msi/nsis get the legacy archive treatment.

Confirmed by building it. With `TAURI_SIGNING_PRIVATE_KEY` set to a key
generated for the purpose, `pnpm tauri build --bundles deb` exits 0 and leaves:

```
Firetower_0.29.0_arm64.deb
Firetower_0.29.0_arm64.deb.sig      ← signed, and no .tar.gz wrapper
```

So `createUpdaterArtifacts: true` *is* satisfied by a `.deb` on Linux: the
package is the artifact and the detached signature sits beside it, exactly as
`has_self_contained_target` says.

The difference that matters is **how** each installs:

| | mechanism | what the user sees |
|---|---|---|
| **AppImage** | rewrites the running AppImage in place | nothing — it just updates, like macOS and Windows |
| **`.deb`** | `pkexec dpkg -i`, then zenity/kdialog sudo, then terminal `sudo` | **a polkit password prompt, every update** |
| **`.rpm`** | `pkexec rpm -U`, same ladder | same |

`try_install_with_privileges` is explicit about the ladder, and step three is
`Command::new("sudo")` — which in a GUI app with no terminal attached simply
fails. The AppImage path has its own constraint: the temp directory must be on
the same mount as the AppImage, or you get
`temp directory is not on the same mount point as the AppImage`.

**Both artifacts were built and the AppImage was run.** `--bundles appimage`
needs one more package than the `.deb` does — see build error 3 — and then:

```
Firetower_0.29.0_aarch64.AppImage       99,346,952 bytes   (95 MiB)
Firetower_0.29.0_aarch64.AppImage.sig          424 bytes
```

no `.tar.gz`, as expected for the v2 updater. It launches and renders
identically to the installed `.deb` —
[`shots/window-appimage.png`](shots/window-appimage.png), `mean=250.80
sd=19.82 colours=794` against the `.deb`'s `250.80 / 19.84 / 794`. (In a
container it needs `APPIMAGE_EXTRACT_AND_RUN=1`, because there is no FUSE;
that is the same flag a user on a FUSE-less machine would need, and it is not
a Firetower problem.)

The price is the size. **95 MiB against the `.deb`'s 8.5 MiB** — eleven times
over — because the AppImage carries its own GTK and WebKitGTK rather than
using the distribution's. That is also exactly why it can self-update without
touching the system.

**So: recommend the AppImage as the primary download, and ship the `.deb` as
the "I manage my own packages" option.** That is the combination that makes the
in-app updater — which is wired up and has a pubkey in the committed config —
actually silent on Linux the way it is elsewhere. If only one artifact is ever
published it should be the AppImage, and the release notes should say what the
95 MiB is for.

## The build errors, and what fixed each

Four, and only two of them are about Linux.

### 1. `tauri build --bundles deb` exits 1 — after producing the `.deb`

```
Finished 1 bundle at:
    …/bundle/deb/Firetower_0.29.0_arm64.deb

A public key has been found, but no private key. Make sure to set
`TAURI_SIGNING_PRIVATE_KEY` environment variable.
       Error A public key has been found, but no private key. …
 ELIFECYCLE  Command failed with exit code 1.
```

Not a Linux problem — `createUpdaterArtifacts: true` and a `pubkey` are in the
committed config, and the release pipeline supplies the private key. It is
worth recording because the artifact is already on disk when it happens, so a
script that checks the exit code concludes the build failed when it did not.

**Fixed by** `--config src-tauri/unsigned.conf.json`, which is already in the
tree for exactly this and sets `createUpdaterArtifacts: false`. `check.sh`
tries the plain command first — so the error is on the record — and retries
with the override.

### 2. `libdbus-1-dev`, which is not on Tauri's list

**Not a failure I hit** — the brief named it, so it went into the image from
the start and I never saw the error. What the run *does* confirm is that the
dependency is real: `Compiling dbus v0.9.12` appears in the build log, pulled
in by `keyring`'s `sync-secret-service` → `dbus-secret-service 4.1.0`, and
that crate links the C library through `pkg-config`. Leave the package out
and its build script is what fails. Worth having in writing, because it is
absent from Tauri's published Linux prerequisites and the error it produces
names `dbus-sys` rather than anything recognisable.

### 3. AppImage bundling fails on a missing `xdg-open`

```
Bundling Firetower_0.29.0_aarch64.AppImage (…/bundle/appimage/…)
failed to bundle project: xdg-open binary not found
  /usr/bin/xdg-open: No such file or directory (os error 2)
```

The AppImage bundler copies `/usr/bin/xdg-open` into the AppDir and refuses
to continue without it. `--bundles deb` does not care, so this only appears
the moment you try to produce the artifact the updater actually wants.
**Fixed by** `xdg-utils` in the image, and this one I did hit and fix. Along
with `libdbus-1-dev` that is two packages beyond Tauri's published Linux
list.

### 4. Everything else was the harness, not the application

Recorded so the next person does not re-derive them:

* **A stale `/tmp/.X99-lock`** survives a killed `Xvfb`, so the second run of
  `check.sh` gets "server is already active", every launch then panics in
  `gtk::rt::init`, and the whole thing looks like a Linux rendering failure.
  `start_display` removes the lock and now *fails loudly* if the display does
  not come up, rather than photographing an empty root.
* **An inline `<script>` in `index.html` is refused** by the committed CSP
  (`default-src 'self'`, no `script-src`), silently. The probe is a file, and
  the probe build turns the CSP off.
* **The probe's collector did not answer `OPTIONS`**, so every POST from the
  webview died in preflight with `TypeError: Load failed`. Three wasted runs.
  Described above under *Networking and the CSP*.
* **Editing `check.sh` while it is running** shifts the byte offsets under the
  interpreter and bash starts executing something else entirely. Twice. Its
  header now says so.

**No change to any file outside `desktop/linux/` was needed to build or run
the application.** The only in-tree file the harness touches is `dist/`, which
is generated.

## What it costs

| | cold | warm |
|---|---|---|
| `docker build` of `Dockerfile.check` | **241 s**, 3.27 GB image | **3 s** |
| `pnpm install --frozen-lockfile` | 6 s | 6 s |
| `pnpm tauri build --bundles deb` | **106 s** (412 crates downloaded, 383 compiled) | **25 s** — measured, after `touch src-tauri/src/main.rs`: 18.7 s to recompile and link the one crate, the rest to bundle. That is what a frontend or `main.rs` change costs |
| `pnpm tauri build --bundles appimage` | ≈4 min, of which most is `linuxdeploy` fetching and packing GTK | ≈2 min |
| install the `.deb` + 4 launches + screenshots | ≈2 min | ≈2 min |
| probe build + 4 instrumented launches | ≈4 min | ≈4 min |
| **`check.sh` with no arguments — every phase** | **≈15 min** | **9 min** (measured: 533 s) |

Twelve cores, Apple Silicon, arm64 throughout. The cargo registry, the build
directory, `node_modules` and the pnpm store are named Docker volumes, so warm
is the normal case after the first run.

**Could this run in CI? Yes, and it should — with one change.** The shape is
right: it is a single `docker build` and a single `docker run`, it needs no
display on the host, and it leaves every measurement in one file. A quarter of
an hour cold is an ordinary job, and less if the AppImage phase is left to a
release workflow rather than run on every push. What makes it CI-grade rather than a toy is that the
screenshots are *measured* — `identify -format '%[fx:mean] %[fx:standard_deviation] %k'`
on every capture — so "the window went blank" is an assertion
(`sd > 5 && colours > 100`) and not something a human has to notice. The empty
root window measures `mean=0 sd=0 colours=1`; a rendered window measures
`mean=250 sd=22 colours=649`. Those are far enough apart to fail a build on.

The change it needs: **x86_64**. This ran `linux/arm64` natively, which is the
right call for a render check — emulated x86 would make every "is it blank"
answer a question about QEMU — but it means **x86_64 packaging is untested**.
Nothing here suggests it would differ, but the `.deb` most users would install
is not the `.deb` that was built. A CI job on an `ubuntu-latest` runner builds
and renders amd64 for free and is the obvious place for this to live.

Two further limits, stated plainly:

* **No GPU.** No `/dev/dri`, Mesa `llvmpipe`. The DMA-BUF question is only
  half-answered (see above) and anything compositor-specific — Wayland,
  fractional scaling, multi-monitor — is out of reach. `devicePixelRatio` was
  1 throughout, so **HiDPI was not tested at all**; on a 2x display the window
  controls, the 78px traffic-light gutter and the icon sizes are all worth a
  look on real hardware.
* **One distribution, one WebKitGTK.** Debian bookworm with 2.50.6 — which,
  being well past the `@property` cutoff, makes this a test of the
  *application* rather than of the engine. An older LTS is where the
  `@property` and `color-mix()` exposure would actually bite, and that is the
  run I would expect to produce a grey page. Changing the `FROM` line in
  `Dockerfile.check` answers it, and it is worth doing before anybody writes
  down a supported-distributions list. **I did not run it**, so the oldest
  WebKitGTK this design survives on is still unknown.

## The harness

Five files, all new, all under `desktop/linux/`. Nothing anywhere else in
the repository was touched:

| file | what it is |
|---|---|
| `Dockerfile.check` | `debian:bookworm` + Tauri's Linux build dependencies + `libdbus-1-dev` + `xdg-utils` + Rust 1.90, Node 22, pnpm 10 + Xvfb, openbox, xdotool, ImageMagick, scrot |
| `run.sh` | from a Mac: builds the image, mounts `desktop/` read-only, mounts `shots/` for output, named volumes for the cargo registry, build directory, `node_modules` and pnpm store |
| `check.sh` | the phases: `env deps build updater install render theme mock connect keychain probes probe_runs source_facts appimage_run`. Any subset can be run on its own |
| `probe.js` | injected into `dist/index.html` for an instrumented build only — never into the application — and answers from **inside the real window**. The only way to get `navigator.platform`, the parsed `@property` count, the font widths and the real `secret_set` error string out of a release webview |
| `probe.mjs` | where those answers land: one HTTP endpoint, one JSON file per run |

```sh
desktop/linux/run.sh                 # everything
desktop/linux/run.sh env deps build  # or any subset of phases
desktop/linux/run.sh --shell         # a prompt inside the container
```

Output lands in `desktop/linux/shots/`: the PNGs, `facts.txt` (every
measurement, one per line), `probe-*.json` (the in-window reports) and
`logs/` (the build and application transcripts).

The source is **copied** into the container rather than bind-mounted for
writing, so a Linux `target/` and a Linux `node_modules/` never land in the
checkout a Mac is also building in.

## What I would do next, in order

1. **Fix the keychain failure mode.** It is the only finding that loses
   somebody's work. Even without a fallback, stop swallowing the error.
2. **Decide the theme default** (above). One line either way, but it is a
   product decision and it should be made on purpose.
3. **Give the window a way to be resized.** `startResizeDragging` in the React
   chrome is the answer that keeps the design.
4. **Add `bundle.category`** so the `.desktop` entry lands in a menu section
   rather than "Other", and consider `mainBinaryName` so the command people
   type is `firetower`.
5. **Put this in CI, on x86_64**, with the blank-window assertion wired to the
   screenshot statistics. That answers the one question this run could not.
6. **Then** decide whether a Linux `capture.rs` is worth 50 lines — it
   probably is, being the cheapest of the three implementations — and whether
   a tray whose only working interaction is a menu item is worth having at
   all.

Nothing on that list is a reason not to ship a Linux build. The expensive,
unknown thing — *does the webview render this design at all* — is answered,
and the answer is yes.
