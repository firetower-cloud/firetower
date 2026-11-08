/**
 * The Dashboard's three states, photographed — and its ember counted.
 *
 *   pnpm mock &  pnpm mock 4402 &  pnpm dev &  pnpm shoot:dashboard
 *
 * **Two Firetowers, both answering.** The avatar's dot and the "waiting
 * elsewhere" line are the whole of what the retired `Fleet.tsx` left behind,
 * and neither can be photographed with one — the second mock plays *waiting*
 * for the length of the run while the first cycles through all three states.
 *
 * It counts as well as shoots, because the one rule on that screen an eye
 * cannot check reliably is the ember budget: **three instances at once in the
 * busiest state, exactly one in the calm one.** An earlier round of the design
 * put six dots there and was rejected for it, and six was not obviously six
 * until somebody counted.
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const OUT = process.env.OUT ?? new URL("../../../.firetower/screenshots", import.meta.url).pathname;
const APP = process.env.APP ?? "http://localhost:5273";
const HERE = process.env.HERE ?? "http://localhost:4401";
const AWAY = process.env.AWAY ?? "http://localhost:4402";
mkdirSync(OUT, { recursive: true });

const REGISTRY = JSON.stringify([
  { url: HERE, serverId: "o_1", org: "Acme", user: "kevin", token: "tok", addedAt: "2026-09-21T09:00:00Z" },
  { url: AWAY, serverId: "o_2", org: "Apex", user: "kp", token: "tok", addedAt: "2026-09-22T09:00:00Z" },
]);

/** waiting → three waiting, calm → five working, empty → a fresh Firetower. */
const SCENES = ["waiting", "calm", "empty"];
/** What the budget allows, per state. */
const BUDGET = { waiting: 3, calm: 1, empty: 1 };

const browser = await chromium.launch({ channel: "chrome" });
let failed = 0;

/* The one that is not here is waiting, for the whole run. */
await (await browser.newContext()).request.post(`${AWAY}/__reset?scene=waiting`);

for (const scene of SCENES) {
  for (const theme of ["light", "dark"]) {
    /* A page each: `theme.ts` writes the attribute at import, and navigating
       to the same hash twice does not reload, so a second theme on the same
       page is the first theme photographed twice. */
    const page = await browser.newPage({ viewport: { width: 1280, height: 824 }, deviceScaleFactor: 2 });
    page.on("pageerror", (e) => console.log(`  pageerror (${scene}/${theme}):`, String(e).slice(0, 200)));
    await page.request.post(`${HERE}/__reset?scene=${scene}`);
    await page.addInitScript(
      ([registry, choice]) => {
        window.localStorage.setItem("firetower.servers", registry);
        window.localStorage.setItem("firetower.current", "o_1");
        window.localStorage.setItem("firetower.theme", choice);
      },
      [REGISTRY, theme],
    );
    await page.goto(`${APP}/#/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1800);
    await page.screenshot({ path: `${OUT}/dashboard-${scene}-${theme}.png` });

    const dots = await page.locator(".dot").count();
    const avatar = await page.locator("nav .bg-ember").count();
    const total = dots + avatar;
    const allowed = BUDGET[scene];
    const verdict = total <= allowed ? "ok" : "OVER BUDGET";
    if (total > allowed) failed++;
    console.log(
      `  ${verdict.padEnd(11)} ${scene}/${theme}: ${dots} on questions + ${avatar} on the avatar = ${total} ember (allowed ${allowed})`,
    );
    await page.close();
  }
}

await browser.close();
console.log(`\n  ${OUT}`);
if (failed) {
  console.error(`\n  ${failed} state(s) over the ember budget.`);
  process.exit(1);
}
