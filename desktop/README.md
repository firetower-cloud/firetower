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

## Nothing is shared with `web/`

The two clients are generated from the same contract, `api/openapi.json`, and
that is the whole relationship. `orval.config.ts` here writes this client's
SDK into `src/api/generated/` with `src/client/http.ts` as the mutator, which
is how the desktop gets a *current server*: a Mac that has connected to
several needs one base URL and one token per server, not one in module scope.

Everything else the desktop once resolved out of `../web` lives here now:
the API helpers in `src/api/`, `Signal`, `AgentMark`, `Markdown` and the
`ui/` primitives in `src/components/`, and the tokens in `src/globals.css`.
The web console keeps its own copies of the few it still uses, and the two
are free to drift: a window wants 34px rows, a title bar that is part of the
app and tabs with ⌘-numbers, none of which a page does.

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
  shims/      the hash router (`navigate`, `usePathname`, `Link`), plus the
              history patch that makes the shell own addresses
  api/        the generated SDK and the hand-written helpers over it
  components/ Signal, AgentMark, Markdown, WhereItRuns, Steps, the ui/ primitives
  client/     the mutator, with a current server
  servers.ts  the registry of connected servers; fleet.ts reads across them
  preview/    the picker bridge, notes, port suggestions
  ui/         Rail, Dashboard, TasksPage, Workbench (+ Chat, Composer,
              Inspector, FileTab, Tabs, QuickOpen, Shell, PreviewTab),
              NewWorkspace, Configuration (+ config/), Connect, Fleet,
              ServerStrip, Titlebar, Palette, StylePage
  syntax.ts   ordered regexes, not a parser — enough to read code by
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

## Weighing the inspector

`scripts/mock-server.mjs` answers with an empty diff unless `FT_MOCK_DIFF` asks
for one: `FT_MOCK_DIFF=8x6000` is eight files of six thousand changed lines, and
`FT_MOCK_DIFF_CHURN=1` moves a line every answer, which is what an agent that is
still working does to the poll. The mock answers `?namesOnly=true` the way the
control plane does — counts and `fresh`, no hunks — and cuts any one patch to
`MOST_OF_A_PATCH`, so both halves of what the server now does are reachable
without a worker. That is the state issue #198 was reported in, and
these probes measure it rather than argue about it:

    FT_MOCK_DIFF=8x6000 FT_MOCK_DIFF_CHURN=1 node scripts/mock-server.mjs 4471 &
    pnpm build && pnpm preview --port 5374 &
    MOCK_PORT=4471 DEV_PORT=5374 node scripts/<probe>.mjs

- `weigh` — heap, node count and keystroke cost with the pane closed, open, and
  after every file has been opened in turn.
- `watch` — the same, sampled every second, so a freeze that lands between two
  polls is still seen.
- `churn` — typing for forty seconds while the diff moves underneath: keystroke
  percentiles, frames over 100 ms, and the megabytes the poll pulled.
- `reflow` — what the composer's autosize costs, which is a whole-document
  layout, against a page with the diff open and with it closed.
- `scrub` — correctness, not speed: scrubs the pane top to bottom and checks the
  drawn rows are the ones the patch has at those positions, that the end of the
  diff is reachable, and that exactly one "ask for a change" control exists.
  Exits non-zero when it is not so, which is the one to run after touching the
  window.
- `stalls` / `profile` — the same run, attributed: `long-animation-frame`
  entries by script, and a CPU profile by self time.
- `when` — the poll against the socket, on one clock. Needs
  `FT_MOCK_EDITS=<ms>`, which makes the mock report a `FileChange` on the
  conversation stream that often; it prints when each edit was announced,
  when each poll answered, and which polls came back byte-identical to the
  one before. `TAB=file` runs it with a file open instead of the
  conversation, which is where the refresh in `Chat.tsx` stops happening.
  `FT_MOCK_EDITS_KIND=McpToolCall` reports the same edit the way a file
  written through an MCP server arrives, which that refresh does not count —
  the poll is what finds those, so it is not redundant.

Measure against `pnpm preview`, not `pnpm dev`: the development build's
`jsxDEV` and prop validation are most of its render cost and none of the
shipped app's.

## Installers

`scripts/build-mac.sh` builds the `.dmg` on this Mac (`--universal` for one
file that runs on Apple Silicon and Intel). A Windows installer can only be
built on Windows: `gh workflow run desktop.yml`, then `gh run download`,
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
universal `.dmg` (`Firetower_<version>_macos.dmg`) with the app signed by the
Developer ID certificate and the image notarized, an `.exe` and `.msi` for
Windows, each with the updater's signature, and `latest.json` — then the
release is published. The signing job runs in the `release` environment: a
reviewer approves it before its secrets are readable. `latest.json` is also
copied onto the rolling `desktop-latest` release, the one fixed address the
app reads: GitHub's own `latest` is whichever package of this repository
released most recently. The app checks it once after start and offers the
update in a dialog. `desktop.yml` runs on pull requests and by hand
(`gh workflow run desktop.yml`, then `gh run download`) and leaves the
unsigned installers as artifacts, which is how a change is tried before it is
released.
