/**
 * Where the eight-second freeze goes, by self time.
 *
 * Takes a CPU profile across two polls of the diff and aggregates it by
 * function, so the answer to "what is doing this" is the profiler's rather than
 * a reading of the code.
 *
 *   FT_MOCK_DIFF=8x6000 FT_MOCK_DIFF_CHURN=1 node scripts/mock-server.mjs 4471 &
 *   MOCK_PORT=4471 DEV_PORT=5373 node scripts/profile.mjs
 */
import { chromium } from "playwright-core";

const MOCK = Number(process.env.MOCK_PORT ?? 4401);
const DEV = Number(process.env.DEV_PORT ?? 5273);

const REGISTRY = JSON.stringify([
  { url: `http://localhost:${MOCK}`, serverId: "o_1", org: "Acme", user: "kevin", token: "tok", addedAt: "2026-09-21T09:00:00Z" },
]);

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, colorScheme: "dark" });
await page.addInitScript(([r]) => {
  window.localStorage.setItem("firetower.servers", r);
  window.localStorage.setItem("firetower.scope", "o_1");
}, [REGISTRY]);

await page.goto(`http://localhost:${DEV}/#/sessions/w_1`, { waitUntil: "networkidle" });
await page.waitForTimeout(6000);

const cdp = await page.context().newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
await cdp.send("Profiler.start");
await page.waitForTimeout(20_000);
const { profile } = await cdp.send("Profiler.stop");

/* Self time per frame, from the sample counts. */
const by = new Map();
const node = new Map(profile.nodes.map((n) => [n.id, n]));
const each = (profile.endTime - profile.startTime) / 1000 / profile.samples.length;
for (const id of profile.samples) {
  const n = node.get(id);
  if (!n) continue;
  const f = n.callFrame;
  const where = f.url ? f.url.split("/").pop().split("?")[0] : "";
  const key = `${f.functionName || "(anonymous)"}  ${where}${f.lineNumber >= 0 ? `:${f.lineNumber + 1}` : ""}`;
  by.set(key, (by.get(key) ?? 0) + each);
}

const ranked = [...by].sort((a, b) => b[1] - a[1]);
const total = ranked.reduce((n, [, ms]) => n + ms, 0);
console.log(`20s of a working session, ${total.toFixed(0)} ms of it on the main thread.\n`);
console.log("   self ms   share   what");
for (const [key, ms] of ranked.slice(0, 22)) {
  if (ms < 15) break;
  console.log(`${ms.toFixed(0).padStart(10)}  ${((ms / total) * 100).toFixed(1).padStart(5)}%   ${key}`);
}

await browser.close();
