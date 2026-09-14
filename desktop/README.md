# Firetower for macOS

A native window onto one or more Firetowers. It connects to a control plane
over the mesh VPN, keeps a token per server, and talks to every server
through the same generated client the web application uses.

## Run it

```sh
pnpm install
pnpm app        # the Mac app (Tauri)
pnpm dev        # or just the renderer, in a browser tab
```

`⌘K` palette · `⌘P` go to a file · `⌘\` inspector · `⌘1`–`⌘3` its tabs ·
`⌘J` shell · `⌘W` close a tab.

The style guide is in the rail while developing.

## What is shared with `web/`, and what is not

**Shared: the vocabulary.** `group()`, `doing()`, `shortRepo()`, `elapsed()`,
`Signal`, `AgentMark`, the `ui/` primitives, and every token in
`globals.css` — resolved out of `../web`, not copied. So both clients group by
repository the same way, decide what a workspace is *doing* the same way, and
mean the same thing by ember.

**Not shared: the screens.** A window is not a page. It wants 34px rows instead
of a 44px touch floor, a title bar that is part of the app, tabs with ⌘-numbers,
and no drawer. Rendering `web/`'s own route components in a window was tried
first and is the wrong trade: it inherits Next's routing and mobile breakpoints
to save work on layouts that have to change anyway.

The line is: **patterns and vocabulary are shared, layout is not.**

## The one module the desktop replaces

`web/orval.config.ts` points all 86 generated operations at one mutator, so
swapping that single module (`src/client/http.ts`) is how the desktop gets a
*current server*: the web's mutator reads one base URL and one token from
module scope, and a Mac that has connected to several needs one per server.
`vite.config.ts` swaps it by resolved path, because orval writes
`import { http } from '../../http'` and an alias on the specifier never sees
it. That was a silent failure once: every request 404s and the screens render
empty rather than wrong.

## Several servers, not one

`src/servers.ts` is the registry — url, `serverId` from `/bootstrap`,
organisation, user, token — and `src/fleet.ts` asks each one for its sessions
so the strip's counts, the palette, `#/fleet` and the dock badge can read
across all of them; each server's own screens are on its event stream. A
server is forgotten from Configuration or the Account page; nothing on the
server changes.

## Layout

```
src/
  shims/      next/link, next/navigation, next/font — the whole Next coupling,
              plus the history patch that makes the shell own addresses
  client/     the mutator, with a current server
  servers.ts  the registry of connected servers; fleet.ts reads across them
  preview/    the picker bridge, notes, port suggestions
  ui/         Rail, Dashboard, TasksPage, Workbench (+ Chat, Composer,
              Inspector, FileTab, Tabs, QuickOpen, Shell, PreviewTab),
              NewWorkspace, Configuration (+ config/), Connect, Fleet,
              ServerStrip, Titlebar, Palette, StylePage
  syntax.ts   ordered regexes, not a parser — enough to read code by
  overrides/  a component copied here wins over the one in ../web
src-tauri/    the shell: window, vibrancy, dock badge, notifications
```

## What is Tauri-specific

`src/bridge.ts` — eight calls. Everything else is shell-agnostic, which is what
keeps a swap to Electron a day rather than a week.

## Previews

A session's port opens in a tab (the globe in the toolbar, or ⌘-less: the
port picker reads addresses out of the conversation). The frame points at the
session's preview hostname, served by the control plane; the app is the
picker's *panel* — the picker the control plane injects into the page accepts
the window that embeds it as the panel when that window is the configured
interface (`#__firetower_ui=`), so notes are written here and kept through the
annotations API. The webview's CSP allows `frame-src http: https:` for this.

## The shell

`⌘J` opens a shell in the session's workspace — the web's protocol (a
WebSocket to `sessions/{id}/pty`, bytes both ways) in `src/ui/Shell.tsx`, with
what an editor's terminal adds: paths in the output open the file at the line,
`⌘F` searches the scrollback, `⌘K` clears. The worker ends the shell when its
viewer detaches, so hiding the panel keeps the terminal mounted; only closing
it lets go. Paths the agent writes in the conversation open the same way
(`src/paths.ts`): found in the text, checked against the workspace with
`find_files`, then opened.

## Installers

`scripts/build-mac.sh` builds the `.dmg` on this Mac (`--universal` for one
file that runs on Apple Silicon and Intel). A Windows installer can only be
built on Windows: `gh workflow run desktop-build.yml`, then `gh run download`,
gives the `.exe` (per-user, what people install) and the `.msi` (for deploying
by policy) from a Windows runner, unsigned. Signing and notarization are the
release workflow's job and happen behind a protected environment; nothing
signing-related is in the tree but the public half of the updater's key.

## Windows

The same app: Tauri on WebView2. The window has no frame there, so the title
bar draws its own buttons; the modifier reads `Ctrl` wherever a shortcut is
written (`src/platform.ts`); in the shell, `Ctrl` is the pty's and the app's
keys are `Ctrl+Shift`; the panels are solid, there being no vibrancy to show
through (`tauri.macos.conf.json` holds what is macOS-only). Tokens are in the
OS keychain on every platform (`bridge.secrets`).

## Releasing

The app has its own release-please package (`desktop`, tags `desktop-v*`,
`desktop/CHANGELOG.md`); commits scoped `(desktop)` land in its release PR.
Merging that PR makes a draft release and runs `desktop-release.yml`: a
universal `.dmg` signed with the Developer ID certificate and notarized, an
`.exe` and `.msi` for Windows, each with the updater's signature, and
`latest.json` — then the release is published, as a pre-release while the
version is 0.x. The signing job runs in the `release` environment: a reviewer
approves it before its secrets are readable. The app checks `latest.json`
once after start and offers the update in a dialog. `desktop-ci.yml` runs on
pull requests; `desktop-build.yml` builds unsigned installers on demand.
