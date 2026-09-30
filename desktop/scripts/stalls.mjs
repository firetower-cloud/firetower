/**
 * What is blocking the main thread, attributed by the browser.
 *
 * `churn.mjs` counts the long frames; this says what is in them. Chrome's
 * `long-animation-frame` entries break a slow frame into the scripts that ran,
 * the style-and-layout time at the end, and the rendering time — so "typing is
 * slow" can be pinned on a function and a phase rather than guessed at.
 *
 *   FT_MOCK_DIFF=8x6000 FT_MOCK_DIFF_CHURN=1 node scripts/mock-server.mjs 4471 &
 *   MOCK_PORT=4471 DEV_PORT=5374 node scripts/stalls.mjs
 */
import { chromium } from "playwright-core";

/* A drawn diff row. `[data-row]` is the windowed pane; `.group/line` is what it
   replaced, kept so this can still measure a checkout from before the change. */
const ROW = "[data-row], .group\\/line";


const MOCK = Number(process.env.MOCK_PORT ?? 4401);
const DEV = Number(process.env.DEV_PORT ?? 5273);
const SECONDS = Number(process.env.SECONDS ?? 40);

const REGISTRY = JSON.stringify([
  { url: `http://localhost:${MOCK}`, serverId: "o_1", org: "Acme", user: "kevin", token: "tok", addedAt: "2026-09-21T09:00:00Z" },
]);

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, colorScheme: "dark" });
page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 300)));
await page.addInitScript(([r]) => {
  window.localStorage.setItem("firetower.servers", r);
  window.localStorage.setItem("firetower.scope", "o_1");
}, [REGISTRY]);

await page.addInitScript(() => {
  window.__loaf = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      window.__loaf.push({
        duration: e.duration,
        blocking: e.blockingDuration,
        // Everything after the last script: style, layout, paint.
        renderStart: e.renderStart ? e.renderStart - e.startTime : 0,
        styleAndLayout: e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0,
        scripts: e.scripts.map((s) => ({
          why: `${s.invoker ?? s.invokerType ?? "?"}`,
          name: s.sourceFunctionName || "(anonymous)",
          at: s.sourceURL ? `${s.sourceURL.split("/").pop()}:${s.sourceCharPosition}` : "",
          dur: +s.duration.toFixed(0),
          forcedLayout: +s.forcedStyleAndLayoutDuration.toFixed(0),
        })),
      });
    }
  }).observe({ type: "long-animation-frame", buffered: true });
});

await page.goto(`http://localhost:${DEV}/#/sessions/w_1`, { waitUntil: "networkidle" });
await page.waitForTimeout(5000);

/* A hand typing into the composer, eight characters a second, while the agent
   keeps editing underneath. */
await page.getByTitle("Hide the inspector").waitFor();
await page.locator("button.group\\/file").first().waitFor({ timeout: 60_000 });
await page.locator(ROW).first().waitFor({ timeout: 60_000 });
await page.locator("textarea").first().click();
await page.evaluate(() => (window.__loaf = []));

await page.evaluate(async (seconds) => {
  const el = document.querySelector("textarea");
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  const until = performance.now() + seconds * 1000;
  while (performance.now() < until) {
    el.focus();
    setter.call(el, `${el.value}x`);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((d) => setTimeout(d, 125));
  }
}, SECONDS);

const loaf = await page.evaluate(() => window.__loaf);
const long = loaf.filter((f) => f.duration >= 50);
const total = long.reduce((n, f) => n + f.duration, 0);
console.log(
  `${SECONDS}s of typing: ${long.length} frames over 50 ms, ${(total / 1000).toFixed(1)}s of the main thread blocked.\n`,
);

/* Rolled up by what the browser says was running. */
const by = new Map();
let styleAndLayout = 0;
for (const f of long) {
  styleAndLayout += f.styleAndLayout;
  for (const s of f.scripts) {
    const key = `${s.why}  →  ${s.name} ${s.at}`;
    const got = by.get(key) ?? { dur: 0, forced: 0, n: 0 };
    by.set(key, { dur: got.dur + s.dur, forced: got.forced + s.forcedLayout, n: got.n + 1 });
  }
}
console.log("      ms   count   forced layout   what ran");
for (const [key, v] of [...by].sort((a, b) => b[1].dur - a[1].dur).slice(0, 14)) {
  console.log(`${String(v.dur).padStart(8)} ${String(v.n).padStart(7)} ${String(v.forced).padStart(15)}   ${key}`);
}
console.log(`\nstyle & layout at the end of those frames: ${styleAndLayout.toFixed(0)} ms`);
console.log(`worst single frame: ${Math.max(...long.map((f) => f.duration)).toFixed(0)} ms`);

await browser.close();
