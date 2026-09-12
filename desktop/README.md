# Firetower for macOS — prototype

A native window around the real interface, on fixtures. No backend, no Rust
sidecar, no Keychain, no signing. It exists to answer two questions: what kind of
client can we get quickly, and what is the style guideline that makes it feel
native.

## Run it

```sh
pnpm install
pnpm app        # the Mac app (Tauri)
pnpm dev        # or just the renderer, in a browser tab
```

Then `#/style` for the design system, which doubles as the remote control.

## How it works

**The components are the real ones.** `vite.config.ts` resolves `@/components/*`
into `../web`, so this renders the same files the web app renders. When one
genuinely fights the native shell it is copied into `src/overrides/` and the
resolver prefers it — which makes that directory the honest list of what did not
survive the move off the web. It is currently empty.

**The API is mocked by replacing one module.** `web/orval.config.ts` points all 86
generated operations at a single mutator, so aliasing `@/src/api/http` is the
entire mock. There is no interceptor and no server.

**Three backends, not one.** `src/mock/backends.ts` holds a personal box and two
companies, each with its own fixtures, latency and reachability. The inbox merges
across them; ember aggregates; one going dark does not affect the others.

**One QueryClient per backend** (`src/backend.tsx`). Generated query keys are
`[url, ...params]` with no server dimension, so two backends answering
`/api/v1/sessions` would collide in one cache. A client each avoids the question
instead of overriding the generator 86 times.

## What is Tauri-specific

`src/bridge.ts` — eight calls. Everything else is shell-agnostic, which is what
keeps a swap to Electron a day's work rather than a week's.

## Layout

```
src/
  shims/      next/link, next/navigation, next/font — 108 lines, the whole
              Next.js coupling
  mock/       three backends, fixtures, a scripted timeline
  ui/         the surfaces that do not exist in web/: server strip, unified
              inbox, title bar, command palette, style page
  overrides/  empty, and that is the finding
src-tauri/    the shell: window, vibrancy, dock badge, notifications
```
