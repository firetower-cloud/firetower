---
name: firetower-artifacts
description: >-
  Publish a page for somebody to look at — a mock-up, a page, a chart, a
  report, a prototype, a diagram — so it appears in the Firetower
  conversation, opens full screen, and can be annotated. Use this whenever
  somebody asks to *see* something rather than change the repository: "show
  me", "mock up", "make a page", "visualise this", "build a dashboard",
  "draw the architecture", "create an artifact". Use it even when the word
  artifact is never said, and use it before writing any standalone HTML file
  — a page written anywhere else is not shown to anybody.
---

# Publishing an artifact

An artifact is a page Firetower serves and shows in the conversation. It opens
full screen, it can be annotated element by element, it survives the session
that made it, and it has a link somebody on this Firetower network can open.

There are two halves to this, and they are not equally negotiable.

**Where it goes is the contract.** Firetower publishes from one path and
watches nothing else. Get this wrong and the work is invisible — not
badly-presented, *invisible*. This half does not change.

**How it looks is craft.** The guidance below is a floor, not a house style.
If a better-equipped skill is available, use it — see the last section.

---

## Where it goes

Write one self-contained HTML file to:

```
.firetower/artifacts/<name>/index.html
```

- `<name>` is lowercase letters, digits and hyphens: `pricing`,
  `onboarding-v2`, `q3-funnel`.
- **One file.** Inline the CSS and the JS. It is served from an origin with no
  network access, so a CDN link, a Google Font, a remote image or a fetch all
  resolve to nothing. Inline the data too.
- **Writing the same `<name>` again publishes a new version** of the same
  artifact rather than a second one. That is how you iterate: edit the file in
  place, and the card in the conversation moves to v2.
- This path sits outside git, so a mock-up never turns up in a pull request.
  Something that belongs in the repository goes in the repository instead.
- Say you have published it, and say what it is called. Do not hand back a
  path inside a scratch directory and call it done — nothing outside
  `.firetower/artifacts/` is ever shown to anybody.

### What it is rendered inside

Knowing this prevents the three failures that actually happen:

- **A frame of arbitrary width**, from roughly 380px to the whole window. Build
  responsive; do not assume a desktop canvas.
- **A white backdrop.** If the page is dark, paint its own background rather
  than relying on what is behind it.
- **Firetower injects its own annotation layer at serve time.** Do not write
  code that reaches for `window.parent` or `window.top`, and do not install a
  global `wheel` or `click` handler that swallows events — that is the
  machinery somebody uses to point at a thing and leave a note on it.

---

## Making it good

A floor, so the default result is not embarrassing:

- Lead with the thing somebody asked to see. If it is a chart, the chart is the
  first thing on the page, not a title card and a legend.
- Set real type. One family is fine; two if they are clearly distinct. Give
  body text a line length under about 80 characters.
- Avoid the look that reads as machine-made: everything in identical rounded
  cards with one shadow, a tracked-out all-caps label above every heading, a
  warm-cream background with a terracotta accent, a single bright accent on
  near-black, meta strings joined with middle dots.
- Spend boldness once. One element carries the page; everything else stays
  quiet.
- Motion answers an action — opening, expanding, confirming. Entrance
  animations on every section are the generic default.
- If it holds data, the data is the design: label axes, state units, and do not
  invent numbers. If something is a placeholder, say so on the page.

---

## If you have a better artifact builder

Many agents ship a richer skill for this — scaffolding a React project,
component libraries, a bundler, a house style. **Use it.** It will produce a
better page than the floor above, and the style guidance here is explicitly
yours to override: its typography, its components, its palette, its build
tooling all win over this file.

What does not change is the delivery:

1. Build however that skill says to build.
2. Those skills finish by producing **one self-contained HTML file** — a
   bundled `bundle.html`, an inlined `dist/index.html`, whatever it calls it.
3. **Copy that file to `.firetower/artifacts/<name>/index.html`.** That step is
   not optional and no other skill knows to do it, because the path belongs to
   Firetower rather than to them.
4. Check it survived bundling: no external fetches, nothing reaching for
   `window.parent`, and it renders at 380px.

The split is worth holding on to. Another skill decides what a good page looks
like. This one decides where a page has to be for anybody to see it.
