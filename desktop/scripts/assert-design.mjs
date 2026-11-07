/**
 * Does the app respect the design — answered factually.
 *
 *   pnpm mock &   pnpm dev &   pnpm assert:design
 *
 * The sweep photographs ninety-nine states in two themes and a person reads
 * the pictures. That worked for the first dozen findings and then stopped:
 * the unpadded tab strip, the white band above the rail and the invisible
 * hover were all *shot* and none was *seen*. Vision does not scale to two
 * hundred images, and a pseudo-class never appears in one at all.
 *
 * So this asserts instead of looking.
 *
 * **Layer 1 — the tokens.** Load the app in both themes, read the resolved
 * value of every design token out of the running document, and compare it
 * against the drawing's own `:root`, parsed from the artifact rather than
 * copied into this file. Nothing to keep in step by hand. Plus the two rules
 * the palette states about itself: every neutral holds `R = G` exactly, and
 * the stated contrast ratios are computed rather than trusted.
 *
 * **Layer 2 — the rules.** Walk the DOM at every state the sweep drives and
 * check the invariants the handoff writes down: no ALL-CAPS, the ember
 * budget, mono only for machine text, `min-height: 0` above every scroller,
 * a contrast floor measured against the ground an element *actually* sits
 * on, and one inset for every child of a page column.
 *
 * Layer 3 — node-for-node correspondence between two separately authored
 * DOMs — is a different and much larger job. Not attempted.
 *
 * What this cannot do is in `design-rules.mjs`, and in the doc. It catches
 * drift, not absence.
 */
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { SHOTS, REGISTRY, attach, fresh } from "./states.mjs";
import { RULES } from "./design-rules.mjs";

const OUT = process.env.OUT ?? new URL("../../.firetower/reconcile", import.meta.url).pathname;
const DRAWING = new URL("../../docs/prototypes/redesign/desktop-redesign.html", import.meta.url).pathname;
const ONLY = process.env.ONLY ?? "";
mkdirSync(OUT, { recursive: true });

/* ── The drawing's palette, read out of the drawing ──────────────────── */

/** `--name:#RRGGBB;` out of a `:root` block, however it is laid out. */
function palette(css) {
  const out = {};
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)[;}]/g)) out[m[1]] = m[2].trim();
  return out;
}
const art = readFileSync(DRAWING, "utf8");
const lightCss = art.slice(art.indexOf("\n:root{"), art.indexOf(':root[data-theme="dark"]'));
const darkCss = art.slice(art.indexOf(':root[data-theme="dark"]'), art.indexOf(':root[data-theme="dark"]') + 2200);
const DRAWN = { light: palette(lightCss), dark: palette(darkCss) };

/**
 * The drawing's names against the build's.
 *
 * The drawing writes the surfaces as furniture — desk, sheet, raised — and
 * the build writes them as position. Same six values; the names were never
 * reconciled because nothing needed them to be until something compared them.
 */
const SAME = {
  "--desk": "--color-ground",
  "--sheet": "--color-panel",
  "--raised": "--color-raise",
  "--sunk": "--color-overlay",
  "--hair": "--color-line",
  "--ink": "--color-bone",
  "--body": "--color-text",
  "--quiet": "--color-dim",
  "--hush": "--color-mute",
  "--ember": "--color-ember",
  "--brick": "--color-brick",
};

/** The ten the `R = G` rule is about. */
const NEUTRALS = [
  "--color-ground", "--color-panel", "--color-raise", "--color-overlay",
  "--color-line", "--color-line-soft", "--color-bone", "--color-text",
  "--color-dim", "--color-mute",
];

const hex = (v) => {
  const m = /^#([0-9a-f]{6})$/i.exec(v.trim());
  if (m) return m[1].toLowerCase();
  const p = /rgba?\(([^)]+)\)/.exec(v);
  if (!p) return null;
  const n = p[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  return n.slice(0, 3).map((x) => Math.round(x).toString(16).padStart(2, "0")).join("");
};

/* ── Drive ───────────────────────────────────────────────────────────── */

const browser = await chromium.launch({ channel: "chrome" });
attach(browser);

const findings = [];
const add = (state, theme, rule, at, expected, actual) =>
  findings.push({ state, theme, rule, at, expected, actual });

/* Layer 1, once per theme — tokens do not vary by screen. */
for (const theme of ["light", "dark"]) {
  const page = await fresh(theme, {});
  await page.goto(`${process.env.APP ?? "http://localhost:5273"}/#/`, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(900);

  const got = await page.evaluate((names) => {
    const s = getComputedStyle(document.documentElement);
    const out = {};
    for (const n of names) out[n] = s.getPropertyValue(n).trim();
    return out;
  }, [...new Set([...Object.values(SAME), ...NEUTRALS])]);

  for (const [drawn, built] of Object.entries(SAME)) {
    const want = DRAWN[theme][drawn];
    if (!want) continue;
    const a = hex(want), b = hex(got[built] ?? "");
    if (a && b && a !== b) add("tokens", theme, "token-value", `${built} (drawn as ${drawn})`, `#${a}`, `#${b}`);
  }

  /* **Every neutral holds `R = G` exactly.** The rule the drawing discovered
     about its own scale rather than invented: the first light derivation
     raised green one to three points above red, which is a different hue and
     not a cooler one, and it read as a blue-grey cast beside a neutral
     product. Only blue is lifted. */
  for (const n of NEUTRALS) {
    const h = hex(got[n] ?? "");
    if (!h) continue;
    const [r, g] = [h.slice(0, 2), h.slice(2, 4)];
    if (r !== g) add("tokens", theme, "neutral-r-equals-g", n, `R = G in #${h}`, `R ${r} ≠ G ${g}`);
  }

  /* **A ΔE is not enough at the ends of the range.** `ground → panel` in
     dark was ΔE 2.2, which looks fine on paper, and a **1.68x relative
     luminance jump**, which is what read as a hard edge — the thing the user
     actually complained about. A check comparing only ΔE would have passed
     it. The ratio of the luminances is the second reading, and near black it
     is the one that matters. */
  const LADDER = ["--color-ground", "--color-panel", "--color-raise", "--color-overlay", "--color-line"];
  const lum = (h) => {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    const f = (x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  for (let i = 0; i < LADDER.length - 1; i++) {
    const a = hex(got[LADDER[i]] ?? ""), b = hex(got[LADDER[i + 1]] ?? "");
    if (!a || !b) continue;
    const [lo, hi] = [lum(a) + 0.05, lum(b) + 0.05].sort((x, y) => x - y);
    const jump = hi / lo;
    /* 1.5x is the line between "a step" and "an edge". The shipped dark
       ladder was 1.68 at the bottom; derived it is 1.37. */
    if (jump > 1.5) {
      add("tokens", theme, "surface-step", `${LADDER[i]} → ${LADDER[i + 1]}`, "at most 1.50x luminance", `${jump.toFixed(2)}x`);
    }
  }

  await page.close();
}
console.log(`  layer 1 · tokens · ${findings.length} finding(s)`);

/**
 * **An exemption that stops applying has to say so.**
 *
 * The ember budget excuses two things — an agent's brand mark, and the
 * workspaces panel, which the user exempted on 7 November 2026. Both are
 * anchored on attributes, and an anchor that moves takes its exemption with
 * it *silently*: the count jumps and the first person to see it concludes the
 * design broke rather than that a selector did. The designer hit exactly that
 * when the panel stopped drawing `.wdot`.
 *
 * So each exemption reports what it suppressed, summed over the whole sweep.
 * Zero across a hundred states in two themes is not restraint; it is an
 * anchor that no longer matches.
 */
const exemptions = new Map();

/* Layer 2, at every state the sweep already drives — the coverage is free. */
let ran = 0;
for (const s of SHOTS) {
  if (s.skip) continue;
  if (ONLY && !s.id.includes(ONLY)) continue;
  for (const theme of ["light", "dark"]) {
    const page = await fresh(theme, { servers: s.servers ?? REGISTRY, scene: s.scene ?? "default", at: s.at ?? null, seed: s.seed ?? null });
    try {
      await s.go(page);
      const found = await page.evaluate(`(${RULES.toString()})()`);
      for (const f of found) {
        /* The exemption tallies are not findings; they are how the sweep
           answers *does each exemption still apply to anything*. */
        if (f.rule === "ember-exemption-tally") {
          exemptions.set(f.at, (exemptions.get(f.at) ?? 0) + Number(f.actual));
          continue;
        }
        add(s.id, theme, f.rule, f.at, f.expected, f.actual);
      }
    } catch (e) {
      add(s.id, theme, "could-not-drive", "—", "the state", String(e).split("\n")[0].slice(0, 140));
    }
    await page.close();
  }
  ran++;
  process.stdout.write(`\r  layer 2 · ${ran} states · ${findings.length} finding(s)`.padEnd(70));
}
await browser.close();
console.log("");

for (const [name, n] of exemptions) {
  if (n > 0) continue;
  add(
    "every state",
    "both",
    "ember-exemption-expired",
    name,
    "the exemption still applies to something",
    "it suppressed nothing in the whole sweep — the anchor has moved, and the budget will now fail as a violation",
  );
}

/* ── Report ──────────────────────────────────────────────────────────── */

const byRule = {};
for (const f of findings) (byRule[f.rule] ??= []).push(f);

const lines = ["# What the app asserts about the design", "",
  `Run \`pnpm assert:design\`. ${findings.length} finding(s) across ${ran} states × 2 themes, plus the token sheet.`,
  "", "Generated — do not edit by hand.", ""];
for (const [rule, fs] of Object.entries(byRule).sort((a, b) => b[1].length - a[1].length)) {
  lines.push(`## \`${rule}\` — ${fs.length}`, "");
  lines.push("| state | theme | where | expected | actual |", "| --- | --- | --- | --- | --- |");
  for (const f of fs.slice(0, 40)) {
    const cell = (v) => String(v).replace(/\|/g, "\\|").slice(0, 110);
    lines.push(`| ${f.state} | ${f.theme} | \`${cell(f.at)}\` | ${cell(f.expected)} | ${cell(f.actual)} |`);
  }
  if (fs.length > 40) lines.push("", `_…and ${fs.length - 40} more._`);
  lines.push("");
}
writeFileSync(`${OUT}/design-assertions.md`, lines.join("\n"));
writeFileSync(`${OUT}/design-assertions.json`, JSON.stringify(findings, null, 2));

for (const [rule, fs] of Object.entries(byRule).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${String(fs.length).padStart(4)}  ${rule}`);
}
console.log(`\n  → ${OUT}/design-assertions.md`);
process.exit(findings.length ? 1 : 0);
