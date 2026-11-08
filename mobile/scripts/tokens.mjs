/**
 * The design tokens, taken from the places they live.
 *
 * `web/app/globals.css` holds the `@theme` block every client is drawn from,
 * and the rule the desktop already follows is that nothing redefines it there.
 * A phone cannot read a CSS file at runtime, so this reads them at build time
 * and writes three things:
 *
 *   tailwind.generated.js  the Tailwind config NativeWind compiles against.
 *                          Its colours are `var()` references and its `base`
 *                          declares those variables per theme, which together
 *                          are the whole switching mechanism — no component
 *                          carries a `dark:`.
 *   tokens.generated.ts    the resolved values for both branches, for the
 *                          places a class name cannot reach — a Reanimated
 *                          worklet, the status bar, an SVG fill, a
 *                          notification accent. Read through
 *                          `src/design/theme.tsx`, never imported raw.
 *
 * The two have **different basenames on purpose.** They were
 * `tokens.generated.js` and `tokens.generated.ts`, and every resolver that
 * puts `.js` before `.ts` — Metro's default `sourceExts` and Vite's default
 * `resolve.extensions` both do — silently handed `import … from
 * "~/design/tokens.generated"` the CommonJS Tailwind config instead. Which
 * exports no `color`, so every imperative colour in the app resolved to
 * `undefined` and fell back to whatever the platform draws with no value.
 * Invisible on a near-black page, and exactly the class of fault this whole
 * file exists to prevent.
 *
 * Run by `just gen` beside orval, and checked by `just gen-check`.
 *
 * ## The four declared sources
 *
 * A colour that exists on the phone and is in none of these is a build
 * failure rather than a review comment. There are four rather than two
 * because two clients have now re-derived values the shared sheet has wrong
 * or does not have, and the alternative to declaring that is hex in a
 * component.
 *
 *   1. `web/app/globals.css` `@theme`               — the dark defaults
 *   2. `web/app/globals.css` `[data-theme="light"]` — the light branch
 *   3. `desktop/src/styles.css` `--color-syn-*`     — the syntax palette only
 *   4. `mobile/src/design/phone.css`                — the phone's overrides
 *
 * Order matters: each later source overrides the earlier ones, per branch.
 * Nothing is written twice, and every override in (4) carries a tag saying
 * whether it is a correction the shared sheet should eventually take or a
 * phone idiom it never should.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shared = resolve(here, "../../web/app/globals.css");
/**
 * And the syntax palette, which lives on the desk.
 *
 * `--color-syn-*` is not in the shared `@theme` — highlighting is a viewer's
 * concern and the desk keeps its own, with a note about why those seven are as
 * muted as they are: four hundred lines of code must not out-shout the one
 * thing on screen that means an agent is waiting on you.
 *
 * Read from there rather than copied to here, and **both** branches now — the
 * desk derived a light syntax set in its own `[data-theme="light"]` block and
 * the phone needs exactly it. The rule this file exists to enforce is that
 * nothing is written twice, and a second palette drifting a shade away from
 * the first is what it is meant to prevent.
 */
const desk = resolve(here, "../../desktop/src/styles.css");
/** The phone's own branch. Read its header before changing anything in it. */
const phoneSheet = resolve(here, "../src/design/phone.css");

const sharedCss = readFileSync(shared, "utf8");
const deskCss = readFileSync(desk, "utf8");
const phoneCss = readFileSync(phoneSheet, "utf8");

/**
 * One brace-balanced block, found by the selector that opens it.
 *
 * The old version of this sliced to the first `\n}`, which works only while
 * no block contains a nested one and silently truncates the moment one does.
 * Counting braces costs four lines and cannot be wrong.
 */
function blockOf(text, selector) {
  const at = text.search(selector);
  if (at < 0) return "";
  const open = text.indexOf("{", at);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open + 1, i);
  }
  return "";
}

/** `--color-ember: #ff6b2c;` → ["color-ember", "#ff6b2c"] */
function declarations(block) {
  const out = [];
  for (const line of block.split("\n")) {
    const m = line.match(/^\s*--([a-z0-9-]+)\s*:\s*([^;]+);/i);
    if (m) out.push([m[1], m[2].trim()]);
  }
  return out;
}

const synOnly = (block) =>
  declarations(block)
    .filter(([n]) => n.startsWith("color-syn-"))
    .map(([n, v]) => `  --${n}: ${v};`)
    .join("\n");

/* The dark branch is the shared `@theme` plus the desk's syntax plus the
   phone's own `@theme`. The light branch is the shared light block on top of
   that — light is an override of dark in `globals.css` and the same here, so
   anything light does not restate it inherits. */
const sharedTheme = blockOf(sharedCss, /@theme\s*\{/);
const sharedLight = blockOf(sharedCss, /\[data-theme="light"\]\s*\{/);
const deskSynDark = synOnly(blockOf(deskCss, /@theme\s*\{/));
const deskSynLight = synOnly(blockOf(deskCss, /\[data-theme="light"\]\s*\{/));
const phoneDark = blockOf(phoneCss, /@theme\s*\{/);
const phoneLight = blockOf(phoneCss, /\[data-theme="light"\]\s*\{/);

const DARK = [sharedTheme, deskSynDark, phoneDark].join("\n");
const LIGHT = [DARK, sharedLight, deskSynLight, phoneLight].join("\n");

/**
 * Sizes the phone overrides, and why — the whole of the density argument, in
 * one place rather than scattered through the screens.
 *
 * The desk took the web's 44px touch floor down to 34px because a Mac is
 * mouse-only. A phone takes it back.
 */
const phoneSpacing = {
  row: "56px",
  "row-tight": "44px",
  control: "44px",
  tap: "44px",
};

/**
 * The type scale, sized for a phone.
 *
 * This started as one override for the transcript and should have been the
 * whole scale from the beginning. The web's sizes exist to fit a workbench
 * into a browser window: `--text-body` is 14px so that a three-pane desk
 * survives at 1280px, and `--text-micro` is 10.5px because a column header
 * beside a mouse pointer can afford to be tiny.
 *
 * None of those pressures exist here, and the opposite one does. A phone is
 * one column, held at arm's length, often in one hand and in motion. iOS sets
 * body text at 17pt and Android at 16sp, and an app that comes in three
 * points under the platform does not read as denser — it reads as *smaller*,
 * which is the one thing a reader notices before they notice anything else
 * you did.
 *
 * So every size moves up roughly a sixth, and the small end moves most,
 * because 10.5px is the size at which text stops being read and starts being
 * squinted at. The line heights are unitless ratios in `globals.css`, so the
 * leading follows on its own and the rhythm is unchanged.
 *
 * What does *not* change is the number of voices. Six sizes and a mono,
 * exactly as on the desk — this is the same scale spoken louder, not a
 * different one.
 */
const phoneText = {
  display: "28px", // the one heading on a screen
  title: "18px", // a row title
  body: "16px", // what somebody reads
  ui: "15px", // controls and labels
  meta: "13px", // captions, counts, paths
  micro: "12px", // eyebrows, column headers, a line-number gutter
  /* Mono stays where it was put. The sans came down a point against
     ChatGPT side by side; the file tree and the diff were the two screens
     that had been left behind and they are the two nobody has complained
     about since. */
  code: "15px", // what the machine said
};

/**
 * Reading, which gets its own size even within that.
 *
 * The thing people do here longest is read a conversation, and that column is
 * narrow and held close. It is one size, not a seventh voice.
 *
 * **17, and the two prose documents have been corrected to match.**
 * `mobile/STYLE.md` and `docs/mobile.md` both said 16px/1.6 while the
 * generated file the app actually reads said 17. The generated file is what
 * draws, so 17 is what is drawn and the documents were stale.
 */
const reading = { read: ["17px", { lineHeight: "1.6" }] };

/**
 * `--text-input` is dropped, and this is the note that says so.
 *
 * It exists in `globals.css` as the 16px floor that stops iOS Safari zooming
 * a focused field — a web problem, which is why `STYLE.md` says it "does not
 * exist here". The generated set carried `input: 17` anyway and nothing in
 * `mobile/src` ever read it. A token nothing reads is a seventh voice waiting
 * for somebody to find it.
 */
const DROPPED = new Set(["input"]);

/** Pull a branch apart into the five kinds of thing a token can be. */
function parse(block) {
  const colors = {};
  const fontSize = {};
  const radius = {};
  const shadows = {};
  const fonts = {};
  for (const [name, value] of declarations(block)) {
    /* `--text-body--line-height` and friends are modifiers on the size above
       them, not sizes of their own. Folded in rather than emitted. */
    const modifier = name.match(/^text-(.+)--(line-height|letter-spacing)$/);
    if (modifier) {
      const [, size, which] = modifier;
      if (DROPPED.has(size)) continue;
      fontSize[size] ??= ["0px", {}];
      fontSize[size][1][which === "line-height" ? "lineHeight" : "letterSpacing"] = value;
      continue;
    }
    if (name.startsWith("color-")) colors[name.slice("color-".length)] = value;
    else if (name.startsWith("text-")) {
      const size = name.slice("text-".length);
      if (DROPPED.has(size)) continue;
      fontSize[size] ??= ["0px", {}];
      fontSize[size][0] = value;
    } else if (name.startsWith("radius-")) radius[name.slice("radius-".length)] = value;
    else if (name === "radius") radius.DEFAULT = value;
    else if (name.startsWith("shadow-")) shadows[name.slice("shadow-".length)] = value;
    else if (name.startsWith("font-")) fonts[name.slice("font-".length)] = value;
  }
  return { colors, fontSize, radius, shadows, fonts };
}

const dark = parse(DARK);
const light = parse(LIGHT);

/* Every colour name either branch knows. A name present in one and missing
   from the other would resolve to nothing in that theme, which is the failure
   mode this sheet exists to make impossible — so it is an error, not a
   fallback. */
const names = [...new Set([...Object.keys(dark.colors), ...Object.keys(light.colors)])].sort();
const missing = names.filter((n) => !dark.colors[n] || !light.colors[n]);
if (missing.length) {
  console.error(`  Not in both branches: ${missing.join(", ")}`);
  process.exit(1);
}

/* The web resolves these through `next/font`; a phone loads the files itself,
   so the family names are the ones `expo-font` is given in `app/_layout.tsx`.
   React Native does not synthesise weights — a bold Archivo is a different
   file, not the same one asked to try harder. So each weight is its own
   family, named exactly as `app/_layout.tsx` loads it. */
const family = {
  sans: ["Archivo_400Regular"],
  medium: ["Archivo_500Medium"],
  semibold: ["Archivo_600SemiBold"],
  narrow: ["ArchivoNarrow_500Medium"],
  mono: ["JetBrainsMono_400Regular"],
  "mono-medium": ["JetBrainsMono_500Medium"],
};

/** The web's modifiers, kept; only the sizes are ours. */
const scaled = Object.fromEntries(
  Object.entries(dark.fontSize).map(([name, [size, mods]]) => [name, [phoneText[name] ?? size, mods]]),
);
const fontSize = { ...scaled, ...reading };

/* ── The custom properties, which are what actually switches ───────────────
   A hex becomes three channels so Tailwind's `<alpha-value>` works on it and
   `bg-ground/60` means something. Anything already carrying its own alpha —
   the scrim — stays whole and is referenced directly; nothing applies an
   alpha modifier to a scrim, and inventing a way to would mean parsing
   `rgb()` back apart to put it together again. */
const channels = (v) => {
  const m = /^#([0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return null;
  const h = m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(" ");
};

const VAR = (name) => `--ft-${name}`;
const varsFor = (palette) => Object.fromEntries(names.map((n) => [VAR(n), channels(palette[n]) ?? palette[n]]));

/**
 * The custom properties, as base styles rather than a second CSS file.
 *
 * `tailwind.config.js` hands this to `addBase`, so it lands in Tailwind's own
 * `@layer base` output and NativeWind compiles it exactly as it would a
 * hand-written rule. An `@import` from `global.css` would say the same thing
 * and depends on `postcss-import` being in a chain nothing here controls;
 * going through the config means the one file that already reads the generated
 * tokens is the only file that has to.
 *
 * **Light is the default and dark is the override**, which is the opposite way
 * round from `globals.css` and deliberate. Light is the design the phone was
 * drawn in, and a `prefers-color-scheme` query is the form NativeWind can
 * switch at runtime — `colorScheme.set()` in `src/design/theme.tsx` drives it,
 * so System, Light and Dark all go through this one block.
 */
const base = {
  ":root": varsFor(light.colors),
  "@media (prefers-color-scheme: dark)": { ":root": varsFor(dark.colors) },
};

/**
 * Two emitted files may never share a basename, and this is why.
 *
 * They did. `tokens.generated.js` held the Tailwind config and
 * `tokens.generated.ts` held the palette, and **every resolver that puts `.js`
 * before `.ts` handed `import { color } from "~/design/tokens.generated"` the
 * CommonJS Tailwind config** — which exports no `color`. So every imperative
 * colour in the app resolved to `undefined`: an icon with no tint, a status
 * bar with no style, a background with no value. Invisible against a
 * near-black page, which is why it shipped.
 *
 * Metro's default `sourceExts` is `["js", "jsx", "json", "ts", "tsx"]` and
 * Vite's `resolve.extensions` is `[".mjs", ".js", ".mts", ".ts", …]`. Both put
 * the JavaScript first. A third generated file is the obvious way to
 * re-introduce this, so the generator refuses rather than trusting the next
 * person to remember.
 */
const EMITTED = ["tailwind.generated.js", "tokens.generated.ts"];
{
  const seen = new Map();
  for (const f of EMITTED) {
    const stem = f.replace(/\.[^.]+$/, "");
    if (seen.has(stem)) {
      console.error(
        `  ${f} and ${seen.get(stem)} share the basename "${stem}".\n` +
          `  Every resolver that puts .js before .ts will hand an import of\n` +
          `  "~/design/${stem}" the wrong one, silently. Rename one.`,
      );
      process.exit(1);
    }
    seen.set(stem, f);
  }
}

const banner = (comment) =>
  `/* Generated from the four sources in scripts/tokens.mjs — do not edit.\n   Run \`just gen\` (or \`pnpm tokens\`) after changing a token in any of them.\n${comment} */\n`;

/* Tailwind gets `var()` references, never values. This is the line that makes
   280 class names in `app/` and `src/` theme-aware without one of them
   changing. */
const tailwindColors = Object.fromEntries(
  names.map((n) => [n, channels(light.colors[n]) ? `rgb(var(${VAR(n)}) / <alpha-value>)` : `var(${VAR(n)})`]),
);

writeFileSync(
  resolve(here, "../src/design/tailwind.generated.js"),
  banner("") +
    "module.exports = " +
    JSON.stringify(
      { colors: tailwindColors, fontSize, radius: dark.radius, fonts: family, spacing: phoneSpacing, base },
      null,
      2,
    ) +
    ";\n",
);

const px = (v) => parseFloat(v) * (String(v).endsWith("rem") ? 16 : 1);
const sizes = Object.fromEntries(Object.entries(fontSize).map(([k, v]) => [k, px(v[0])]));
const radii = Object.fromEntries(Object.entries(dark.radius).map(([k, v]) => [k, parseFloat(v)]));
const palette = (p) => Object.fromEntries(names.map((n) => [n, p[n]]));

writeFileSync(
  resolve(here, "../src/design/tokens.generated.ts"),
  banner(`
   Both branches, resolved. Do not import \`light\` or \`dark\` directly from a
   component — \`src/design/theme.tsx\` picks between them for the active theme
   and a component that reaches past it is a component that does not follow
   the theme. \`Palette\` is the type of either.`) +
    "export const light = " +
    JSON.stringify(palette(light.colors), null, 2) +
    " as const;\n\nexport const dark = " +
    JSON.stringify(palette(dark.colors), null, 2) +
    " as const;\n\n" +
    "/* Widened on purpose. `as const` on each branch is worth keeping — it is\n" +
    "   what makes `color.` autocomplete and what catches a misspelt token at\n" +
    "   build time — but it also makes the two branches two *different* literal\n" +
    "   types, neither assignable to the other. A palette is a map of the same\n" +
    "   names to colours, and that is what a component is handed. */\n" +
    "export type Palette = { readonly [K in keyof typeof light]: string };\n\nexport const size = " +
    JSON.stringify(sizes, null, 2) +
    " as const;\n\nexport const radius = " +
    JSON.stringify(radii, null, 2) +
    " as const;\n\nexport const shadow = { light: " +
    JSON.stringify(light.shadows, null, 2) +
    ", dark: " +
    JSON.stringify(dark.shadows, null, 2) +
    " } as const;\n",
);

console.log(
  `  ${names.length} colours × 2 branches, ${Object.keys(fontSize).length} sizes, ` +
    `${Object.keys(radii).length} radii — from globals.css, desktop/styles.css and phone.css`,
);
