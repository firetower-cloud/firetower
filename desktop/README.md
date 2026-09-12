# Firetower for macOS — prototype

A native window over fixtures. No backend, no Rust sidecar, no Keychain, no
signing. It exists to answer what kind of client we can get quickly, and what
the style guideline is once the window is native and holds more than one server.

## Run it

```sh
pnpm install
pnpm app        # the Mac app (Tauri)
pnpm dev        # or just the renderer, in a browser tab
```

`⌘K` palette · `⌘P` go to a file · `⌘\` inspector · `⌘1`–`⌘3` its tabs ·
`⌘J` terminal · `⌘W` close a file.

The style guide is in the rail, and doubles as the remote control: drop a
server, fire an ember, stall a request.

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

## The mock

`web/orval.config.ts` points all 86 generated operations at one mutator, so
swapping that single module is the whole fake — `vite.config.ts` does it by
resolved path, because orval writes `import { http } from '../../http'` and an
alias on the specifier never sees it. That was a silent failure once: every
request 404s and the screens render empty rather than wrong.

Conversations are fixtures, not a fake event log. The control plane models a
transcript as `SessionConfigured` / `TurnStarted` / `ItemStarted` / deltas;
reproducing that faithfully teaches us nothing about how a window feels.

## Three servers, not one

`src/mock/backends.ts` holds a personal box and two companies, each with its own
fleet, latency and reachability. The strip switches between them, ember sums
across all of them onto the dock badge, and `#/fleet` merges them into one
screen — the only surface here that `web/` could not have.

One is knocked offline 30 seconds in and comes back at 58, because the memo
expects unreachable to be the common state and it has to look deliberate.

## Layout

```
src/
  shims/      next/link, next/navigation, next/font — the whole Next coupling,
              plus the history patch that makes the shell own addresses
  mock/       three backends, fixtures, a scripted timeline
  ui/         Rail, Dashboard, TasksPage, Workbench (+ Chat, Composer,
              Inspector, FileTab, Tabs, QuickOpen, TerminalPane),
              NewWorkspace, Configuration, Fleet, ServerStrip, Titlebar,
              Palette, StylePage
  syntax.ts   ordered regexes, not a parser — enough to read code by
  overrides/  a component copied here wins over the one in ../web
src-tauri/    the shell: window, vibrancy, dock badge, notifications
```

## What is Tauri-specific

`src/bridge.ts` — eight calls. Everything else is shell-agnostic, which is what
keeps a swap to Electron a day rather than a week.
