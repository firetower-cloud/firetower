/**
 * The prototype's 96 states, photographed — the reference half of the
 * reconciliation.
 *
 *   pnpm shoot:proto
 *
 * `desktop-redesign.html` draws every state as a tile on its `Every screen`
 * tab at a third scale, which is enough to see that a screen exists and not
 * nearly enough to compare type, spacing or weight against a build. This
 * drives the same `SHEET` table the contact sheet is generated from, one state
 * at a time, at the window's own 1280×824, in both themes.
 *
 * It reads the prototype and writes nothing into it. The file is the
 * specification and is not this script's output.
 */
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = process.env.OUT ?? new URL("../../.firetower/reconcile/proto", import.meta.url).pathname;
const PROTO = new URL("../../docs/prototypes/redesign/desktop-redesign.html", import.meta.url).href;
mkdirSync(OUT, { recursive: true });

/**
 * The Dashboard's reference moved.
 *
 * `home-alternative.html` supersedes `desktop-redesign.html` for that screen
 * and nothing else, so those three states are shot from the other file. When
 * the designer folds it into the main artifact this map empties and the
 * sweep has one authority again — which is the point of recording it here
 * rather than remembering it.
 */
const HOME = new URL("../../docs/prototypes/redesign/home-alternative.html", import.meta.url).href;
const MOVED = {
  "starting-work__dashboard-two-waiting": { at: HOME, state: { state: "waiting" } },
  "starting-work__dashboard-nothing-waiting": { at: HOME, state: { state: "calm" } },
  "starting-work__dashboard-nothing-yet": { at: HOME, state: { state: "empty" } },
};

const browser = await chromium.launch({ channel: "chrome" });
/* Wide enough that `fit()` leaves SCALE at 1 — a scaled element screenshot is
   a scaled photograph, and the whole point here is full size. */
const page = await browser.newPage({ viewport: { width: 1700, height: 1100 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("  pageerror:", String(e).slice(0, 200)));
await page.goto(PROTO, { waitUntil: "load" });
await page.waitForTimeout(600);

/** The table, read out of the document rather than copied into this file. */
const sheet = await page.evaluate(() =>
  SHEET.map(([group, rows]) => [group, rows.map(([label, patch]) => [label, patch])]),
);

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const index = [];
let n = 0;
for (const [group, rows] of sheet) {
  for (const [label, patch] of rows) {
    const id = `${slug(group)}__${slug(label)}`;
    const moved = MOVED[id];
    if (moved) {
      /* A second page: the two files are different documents with different
         globals, and navigating back and forth per theme is slower than
         keeping one open. */
      const alt = await browser.newPage({ viewport: { width: 1700, height: 1100 }, deviceScaleFactor: 2 });
      await alt.goto(moved.at, { waitUntil: "load" });
      await alt.waitForTimeout(500);
      for (const theme of ["light", "dark"]) {
        await alt.evaluate(
          ([patch, theme]) => {
            Object.assign(S, patch, { theme, tab: "home" });
            render();
          },
          [moved.state, theme],
        );
        await alt.waitForTimeout(160);
        await alt.locator(".win").first().screenshot({ path: `${OUT}/${id}-${theme}.png` });
      }
      await alt.close();
      index.push({ group, label, id, patch, from: "home-alternative.html" });
      n++;
      process.stdout.write(`\r  ${n}/96  ${label}`.padEnd(70));
      continue;
    }

    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        ([patch, theme]) => {
          /* BASE carries every key, so assigning it is a full reset — a
             latched overlay otherwise draws over every later state. */
          Object.assign(S, BASE, patch, { theme, tab: patch.tab });
          render();
        },
        [patch, theme],
      );
      await page.waitForTimeout(140);
      await page.locator("#win").screenshot({ path: `${OUT}/${id}-${theme}.png` });
    }
    index.push({ group, label, id, patch });
    n++;
    process.stdout.write(`\r  ${n}/96  ${label}`.padEnd(70));
  }
}
writeFileSync(`${OUT}/index.json`, JSON.stringify(index, null, 2));
await browser.close();
console.log(`\n  ${n} states × 2 themes → ${OUT}`);
