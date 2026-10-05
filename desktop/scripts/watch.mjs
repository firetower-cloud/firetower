/**
 * The diff pane under a working agent, sampled second by second.
 *
 * Loads the workspace as it comes up — inspector open, diff tab, first file
 * expanded — against a mock whose diff moves every answer, and prints the heap,
 * the node count and the longest frame each second. What this is looking for is
 * whether the pane ever settles between polls, or whether the next one lands
 * before the last has finished being drawn.
 *
 *   FT_MOCK_DIFF=8x6000 FT_MOCK_DIFF_CHURN=1 node scripts/mock-server.mjs 4471 &
 *   MOCK_PORT=4471 DEV_PORT=5373 node scripts/watch.mjs
 */
import { chromium } from "playwright-core";

/* A drawn diff row. `[data-row]` is the windowed pane; `.group/line` is what it
   replaced, kept so this can still measure a checkout from before the change. */
const ROW = "[data-row], .group\\/line";


const MOCK = Number(process.env.MOCK_PORT ?? 4401);
const DEV = Number(process.env.DEV_PORT ?? 5273);
const SECONDS = Number(process.env.SECONDS ?? 45);

const REGISTRY = JSON.stringify([
  { url: `http://localhost:${MOCK}`, serverId: "o_1", org: "Acme", user: "kevin", token: "tok", addedAt: "2026-09-21T09:00:00Z" },
]);

const browser = await chromium.launch({ channel: "chrome", args: ["--enable-precise-memory-info"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, colorScheme: "dark" });
page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 300)));
await page.addInitScript(([r]) => {
  window.localStorage.setItem("firetower.servers", r);
  window.localStorage.setItem("firetower.scope", "o_1");
}, [REGISTRY]);

/* Frame times, collected in the page from the moment it loads. */
await page.addInitScript(() => {
  window.__frames = [];
  let last = performance.now();
  const tick = (now) => {
    window.__frames.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

let diffCalls = 0;
let diffBytes = 0;
page.on("response", (r) => {
  if (!r.url().includes("/diff")) return;
  diffCalls++;
  void r
    .body()
    .then((b) => (diffBytes += b.length))
    .catch(() => {});
});

const at = Date.now();
await page.goto(`http://localhost:${DEV}/#/sessions/w_1`, { waitUntil: "commit" });

console.log("  t   heap   nodes   rows  longest frame   diff GETs / MB");
for (let s = 1; s <= SECONDS; s++) {
  await page.waitForTimeout(1000);
  const m = await page
    .evaluate((row) => {
      const f = window.__frames.splice(0);
      return {
        heap: +(performance.memory.usedJSHeapSize / 1e6).toFixed(0),
        nodes: document.getElementsByTagName("*").length,
        rows: document.querySelectorAll(row).length,
        longest: +Math.max(0, ...f).toFixed(0),
      };
    }, ROW)
    .catch(() => null);
  if (!m) {
    console.log(`${String(s).padStart(3)}s  the page would not answer`);
    continue;
  }
  console.log(
    `${String(s).padStart(3)}s ${String(m.heap).padStart(5)} MB ${String(m.nodes).padStart(7)} ${String(m.rows).padStart(6)} ${String(m.longest).padStart(9)} ms ${String(diffCalls).padStart(9)} / ${(diffBytes / 1e6).toFixed(0)}`,
  );
}
console.log(`\n${((Date.now() - at) / 1000).toFixed(0)}s in total: ${diffCalls} diff reads, ${(diffBytes / 1e6).toFixed(0)} MB pulled.`);

await browser.close();
