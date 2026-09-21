/**
 * The design tokens, taken from the one place they live.
 *
 * `web/app/globals.css` holds the `@theme` block every client is drawn from,
 * and the rule the desktop already follows is that nothing redefines it. A
 * phone cannot read a CSS file at runtime, so this reads it at build time and
 * writes two things:
 *
 *   tokens.generated.js   the Tailwind config NativeWind compiles against
 *   tokens.generated.ts   the raw values, for the places a class name cannot
 *                         reach — Reanimated worklets, the status bar, the
 *                         Android navigation bar, the notification accent
 *
 * Run by `just gen` beside orval, and checked by `just gen-check`, so a colour
 * that exists here and not in `globals.css` is a build failure rather than a
 * review comment.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../../web/app/globals.css");

const css = readFileSync(source, "utf8");

/* The `@theme` block, and only it. Everything after it is components, which
   are Tailwind's business on the web and ours here. */
const theme = css.slice(css.indexOf("@theme {") + "@theme {".length, css.indexOf("\n}", css.indexOf("@theme {")));

/** `--color-ember: #ff6b2c;` → ["color-ember", "#ff6b2c"] */
function declarations(block) {
  const out = [];
  for (const line of block.split("\n")) {
    const m = line.match(/^\s*--([a-z0-9-]+)\s*:\s*([^;]+);/i);
    if (m) out.push([m[1], m[2].trim()]);
  }
  return out;
}

const colors = {};
const fontSize = {};
const radius = {};
const shadows = {};
const fonts = {};

for (const [name, value] of declarations(theme)) {
  /* `--text-body--line-height` and friends are modifiers on the size above
     them, not sizes of their own. Folded in rather than emitted. */
  const modifier = name.match(/^text-(.+)--(line-height|letter-spacing)$/);
  if (modifier) {
    const [, size, which] = modifier;
    fontSize[size] ??= ["0px", {}];
    fontSize[size][1][which === "line-height" ? "lineHeight" : "letterSpacing"] = value;
    continue;
  }
  if (name.startsWith("color-")) colors[name.slice("color-".length)] = value;
  else if (name.startsWith("text-")) {
    const size = name.slice("text-".length);
    fontSize[size] ??= ["0px", {}];
    fontSize[size][0] = value;
  } else if (name.startsWith("radius-")) radius[name.slice("radius-".length)] = value;
  else if (name === "radius") radius.DEFAULT = value;
  else if (name.startsWith("shadow-")) shadows[name.slice("shadow-".length)] = value;
  else if (name.startsWith("font-")) fonts[name.slice("font-".length)] = value;
}

/* The web resolves these through `next/font`; a phone loads the files itself,
   so the family names are the ones `expo-font` is given in `app/_layout.tsx`. */
/* React Native does not synthesise weights — a bold Archivo is a different
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

/**
 * Sizes the phone overrides, and why — the whole of the density argument, in
 * one place rather than scattered through the screens.
 *
 * The desk took the web's 44px touch floor down to 34px because a Mac is
 * mouse-only. A phone takes it back. Reading goes the other way: `--text-read`
 * at 15px was chosen for a 46rem column on a monitor, and a 390pt phone holds
 * a narrower column at a shorter distance.
 */
const phone = {
  row: "56px",
  "row-tight": "44px",
  control: "44px",
  tap: "44px",
};

/**
 * Reading, sized for a phone.
 *
 * `--text-body` is 14px because the web scale has to fit a workbench into
 * 390px of browser. The thing people do here longest is read a conversation,
 * and on a phone that column is narrow and held closer, so it gets its own
 * size — the desk made the same move in the other direction with `--text-read`
 * at 15px for a 46rem column on a monitor.
 *
 * It is one size, not a seventh voice: everything that is not the transcript
 * keeps the tokens as they are.
 */
const reading = { read: ["16px", { lineHeight: "1.6" }] };

const banner = `/* Generated from web/app/globals.css by scripts/tokens.mjs — do not edit.\n   Run \`just gen\` (or \`pnpm tokens\`) after changing a token there. */\n`;

writeFileSync(
  resolve(here, "../src/design/tokens.generated.js"),
  banner +
    "module.exports = " +
    JSON.stringify({ colors, fontSize: { ...fontSize, ...reading }, radius, fonts: family, spacing: phone }, null, 2) +
    ";\n",
);

writeFileSync(
  resolve(here, "../src/design/tokens.generated.ts"),
  banner +
    "export const color = " + JSON.stringify(colors, null, 2) + " as const;\n\n" +
    "export const size = " + JSON.stringify(Object.fromEntries(Object.entries({ ...fontSize, ...reading }).map(([k, v]) => [k, parseFloat(v[0]) * (v[0].endsWith("rem") ? 16 : 1)])), null, 2) + " as const;\n\n" +
    "export const radius = " + JSON.stringify(Object.fromEntries(Object.entries(radius).map(([k, v]) => [k, parseFloat(v)])), null, 2) + " as const;\n\n" +
    "export const shadow = " + JSON.stringify(shadows, null, 2) + " as const;\n",
);

console.log(`  ${Object.keys(colors).length} colours, ${Object.keys(fontSize).length} sizes, ${Object.keys(radius).length} radii — from web/app/globals.css`);
