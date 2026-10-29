---
name: firetower-artifacts
description: Publish a page for somebody to look at — a mock-up, a page, a chart, a report, a prototype, a diagram — so it appears in the Firetower conversation, opens full screen, and can be annotated. Use this whenever somebody asks to *see* something rather than change the repository: "show me", "mock up", "make a page", "visualise this", "build a dashboard", "draw the architecture", "prototype this feature", "create an artifact". Use it even when the word artifact is never said, and use it before writing any standalone HTML file — a page written anywhere else is not shown to anybody. When the page belongs to an application checked out here, it has to look like that application, and this says how.
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
If a better-equipped skill is available, use it — see the last section. And if
the page belongs to an application checked out here, that application's own
design outranks both the floor and the other skill — see the middle section.

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
  resolve to nothing. Inline the data too, and the fonts: a family the page
  names but does not carry falls back to the system face without a word.
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

## If it belongs to an application checked out here

A feature for a product whose code is in this workspace, a change to one of
its screens, a new page in it: the person asking already has a picture of what
it should look like, and the picture is the application. A page in some other
style is not a prototype of the feature. It is a different product with the
feature in it, and every note left on it will be about the wrong thing.

**The application's design system wins** — over the floor below, and over the
theme of any other artifact builder. The rest of this section is what that
costs.

**Decide which client owns the page.** A repository can hold several — a web
app, a desktop app, a phone app — and they rarely share a layout even when
they share tokens. The screens the request names say which one; its routes or
its pages directory confirm it. Everything that follows comes from that
client.

**Find the design system before drawing anything.** In this order, and stop
when the picture is complete:

1. **A style guide.** `STYLE.md`, `DESIGN.md`, a design section in the
   contributing guide, a page under `docs/`. It carries the rules, and often
   the tells by which a generated page gives itself away. Those are the rules
   this page is held to.
2. **The tokens.** A Tailwind `@theme` block or config, a sheet of CSS custom
   properties, a theme module. Colours, type scale, radii, shadows, motion.
   Copy them verbatim — not rounded, not renamed, not improved.
3. **The fonts**, which are usually checked in beside the client that loads
   them. Embed them as `@font-face` with base64 data. A handful of font files
   is small, and without them nothing else matters: the system face alone is
   enough to make a prototype look like somebody else's product.
4. **The primitives.** A `components/ui` directory, or wherever the button,
   the panel, the row and the field are defined. Read how each is built: what
   a primary action looks like, what carries elevation, how tall a list row is.
5. **A rendered catalog**, if there is one — a style page, a Storybook, a
   components route. The fastest way to see every state at once.

**Show the page as it is now.** Somebody judging a change needs the thing
being changed. Put the current page in the artifact as the first view, with
the proposal beside it or a toggle away. Where the repository can photograph
itself — a screenshot script, a mock server the client runs against — use
that. Where it cannot, rebuild the current page by the same method as the
proposal, and say on the page that it is a rebuild.

**Build it one of two ways.**

- **With the repository's own toolchain**, when the prototype needs real
  interaction or more than a few components. Add an entry that imports the
  real stylesheet and the real components over mock data, build it with the
  bundler the repository already uses, and inline the output into one file.
  This is the only route that uses the actual components, and it is what
  makes the result something to test rather than a picture of one. It costs
  an install and a build the first time; say so, then do it.
- **By hand**, when the page is static or the change is small. Copy the
  tokens and the fonts into the page verbatim and reproduce the primitives
  from their source. Hand-built on the real tokens is fine. Built from a
  generic theme and tinted to match is not.

**Check it against the application before publishing.** The colour scheme is
painted, not inherited from the frame. The families the page names are the
ones it carries. None of the tells the style guide names are on the page. The
data is shaped like the application's data, not placeholder text. The flow
under test can be walked: the control that was asked for opens, filters,
submits. And it still reads at the narrowest frame width.

---

## Making it good

A floor, not a house style. An application's own design system replaces all
of it, and so may another skill. Where neither applies, this is what keeps the
default result from being embarrassing.

**Lead with the thing that was asked for**, in the form that suits it: the
chart, the screen, the number, the comparison. A title card and a legend ahead
of the content is a slide, not a page.

**Type carries the personality.** One family, or two if they are clearly
distinct. Set a real scale rather than three sizes of one weight. Body text
under about 80 characters a line; serif wants more line-height than sans.

**Structure is information.** A rule, a border, a number should encode
something about the content rather than decorate it. Numbered markers belong on
a sequence — a process, a timeline — and nowhere else.

**Spend boldness once.** One element is the memorable thing and everything
around it stays quiet. Then take one more thing out than feels comfortable.

**Motion answers an action** — opening, expanding, confirming. Entrance
animations on each section and a hover transition on every card are the
generic default.

**Say true things.** Label axes, state units, name the period. If a number is
invented, say so on the page: a plausible fake is worse than a blank.

### What reads as machine-made

Defaults rather than choices, and they turn up whatever the subject:

- a warm cream background with a high-contrast serif and a terracotta accent;
- near-black with a single bright acid-green or vermilion accent;
- purple gradients, uniform rounded corners everywhere, and Inter;
- content chopped into identical cards — one radius on everything regardless of
  hierarchy, the same soft grey shadow under each, gradient washes as filler;
- a tracked-out ALL-CAPS label above every heading; meta strings joined with
  middle dots; one word of a headline in italic or a different colour; an arrow
  appended to every link and button.

Any of these is right for a brief that calls for it. None of them is right
because it was the first thing to hand. An application that is built on one of
them is a brief that calls for it: a prototype of its pages looks the way it
looks.

### A floor to hit without announcing it

Readable down to a phone, visible keyboard focus, `prefers-reduced-motion`
respected, text that passes contrast in whatever scheme the page paints. If the
page carries data and a `dataviz` skill is available, use it rather than
inventing a palette — the colours are the hard part and it has done it already.

## If you have a better artifact builder

Many agents ship a richer skill for this — `web-artifacts-builder` scaffolds a
React, Tailwind and shadcn project and bundles it to one file;
`frontend-design` carries a fuller design method; `dataviz` knows charts.
Whatever is available, **use it.** It will produce a better page than the
floor above.

How much of it wins depends on whose page this is:

- **A page that stands on its own.** All of it. The style guidance here is
  explicitly yours to override: its typography, its components, its palette,
  its build tooling all win over this file.
- **A page of an application checked out here.** Its build tooling wins; its
  theme does not. Scaffold with it, then replace the scaffold's tokens, fonts
  and stock components with the application's before drawing anything. A
  kit's page in the application's accent colour is still the kit's page.

What does not change is the delivery:

1. Build however that skill says to build.
2. Those skills finish by producing **one self-contained HTML file** — a
   bundled `bundle.html`, an inlined `dist/index.html`, whatever it calls it.
3. **Copy that file to `.firetower/artifacts/<name>/index.html`.** That step is
   not optional and no other skill knows to do it, because the path belongs to
   Firetower rather than to them.
4. Check it survived bundling: no external fetches, nothing reaching for
   `window.parent`, and it renders at 380px — and, for an application's page,
   that the fonts and tokens on it are the application's rather than the
   scaffold's.

The split is worth holding on to. Another skill decides what a good page looks
like. This one decides where a page has to be for anybody to see it — and that
a page of an application looks like that application.
