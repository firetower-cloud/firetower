# Firetower — UI prototype

A clickable prototype of the Firetower control plane. **UI only** — every task, host,
and diff comes from `lib/data.ts`. There is no server, no worker, no agent.

```bash
npm install
npm run dev
```

## Screens

| Route          | What it shows                                                          |
| -------------- | ---------------------------------------------------------------------- |
| `/`            | The inbox — horizon, composer, needs-you / working / recent            |
| `/tasks/[id]`  | Terminal, diff + review, files, activity, and the workspace rail        |
| `/compute`     | Hosts, capacity, draining, and the add-host bootstrap log               |
| `/repos`       | Connected repositories, setup script, injected secrets                 |
| `/mobile`      | The four phone screens on the buzz → unblocked path                    |

Interactive bits worth clicking: the composer (focus it), the reply box on a
needs-you card, "Ask about this" on a diff hunk, and "+ Add a host" on `/compute`.

## The three ideas the design is arguing for

**The dashboard is an inbox, not a fleet monitor.** Tasks sort by *does this need me*,
not by recency. A finished task lands in "Needs you" alongside a question, because
both mean the same thing: the agent stopped being useful without you.

**Ember is reserved.** One saturated colour in the whole system, and it only ever
means "your move". A task that's happily working gets no loud affordance — look at
the action rail on a running task versus a finished one.

**The terminal is the page.** Not a button you press to reveal the real thing. The
one exception is mobile, where a waiting task shows the parsed question and a reply
box first, with the full PTY one tap away.

## Design tokens

Defined in `app/globals.css` under `@theme`.

- Ground is warm ash (`#0c0b0a`), not neutral black.
- Signals: `ember` needs you · `slate` working · `sage` finished · `brick` failed.
- Archivo (UI), Archivo Narrow (instrument labels), JetBrains Mono (data, terminal).

## Not built

Auth, settings, search / ⌘K, notification preferences, task history, and every
empty state except the implicit ones. The `⤢ Fullscreen`, `Files`-tree, and all
push/commit actions are inert.
