/**
 * The build's states, photographed — the other half of the reconciliation.
 *
 *   pnpm mock &   pnpm dev &   pnpm shoot:app
 *
 * One entry per state in the prototype's `SHEET`, keyed by the same id
 * `shoot-proto.mjs` writes, so the two directories line up file for file and
 * `reconcile.mjs` can put them side by side. The table itself is in
 * `states.mjs`, because `assert-design.mjs` drives the same states.
 */
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { SHOTS, PROTO, REGISTRY, attach, fresh } from "./states.mjs";

const OUT = process.env.OUT ?? new URL("../../.firetower/reconcile/app", import.meta.url).pathname;
const ONLY = process.env.ONLY ?? "";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });
attach(browser);

/* Every prototype state is in the table, exactly once. */
const want = JSON.parse(readFileSync(`${PROTO}/index.json`, "utf8")).map((s) => s.id);
const have = SHOTS.map((s) => s.id);
const missing = want.filter((id) => !have.includes(id));
const extra = have.filter((id) => !want.includes(id));
if (missing.length || extra.length) {
  console.error("  table does not match the prototype's:", { missing, extra });
  process.exit(1);
}

/* Merged, not overwritten: `ONLY=settings` used to leave the index holding
   twelve rows and `reconcile.mjs` reporting the other eighty-four as "not in
   the app's table", which is the one thing this file exists not to do. */
const before = existsSync(`${OUT}/index.json`) ? JSON.parse(readFileSync(`${OUT}/index.json`, "utf8")) : [];
const log = ONLY ? before.filter((r) => !r.id.includes(ONLY)) : [];
let shot = 0,
  skipped = 0,
  broke = 0;
for (const s of SHOTS) {
  if (ONLY && !s.id.includes(ONLY)) continue;
  if (s.skip) {
    log.push({ id: s.id, state: "skipped", why: s.skip });
    skipped++;
    continue;
  }
  for (const theme of ["light", "dark"]) {
    const page = await fresh(theme, { servers: s.servers ?? REGISTRY, scene: s.scene ?? "default", at: s.at ?? null, seed: s.seed ?? null });
    try {
      await s.go(page);
      await page.screenshot({ path: `${OUT}/${s.id}-${theme}.png` });
      if (theme === "dark") {
        log.push({ id: s.id, state: "shot" });
        shot++;
      }
    } catch (e) {
      console.log(`\n  ✗ ${s.id} (${theme}): ${String(e).split("\n")[0].slice(0, 160)}`);
      if (theme === "dark") {
        log.push({ id: s.id, state: "broke", why: String(e).split("\n")[0].slice(0, 200) });
        broke++;
      }
    }
    await page.close();
  }
  process.stdout.write(`\r  ${shot + broke}/${SHOTS.length - skipped}  ${s.id}`.padEnd(78));
}

/* Back into the prototype's order, so the file reads as the sheet reads. */
log.sort((a, b) => want.indexOf(a.id) - want.indexOf(b.id));
writeFileSync(`${OUT}/index.json`, JSON.stringify(log, null, 2));
await browser.close();
console.log(`\n  ${shot} shot · ${skipped} not reachable yet · ${broke} failed → ${OUT}`);
