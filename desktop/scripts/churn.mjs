/**
 * Typing while the agent is still editing — issue #198's actual conditions.
 *
 * `weigh.mjs` measures a diff that has stopped moving. This one runs against a
 * mock whose diff changes every answer, which is what a working agent does, and
 * samples the keystroke cost continuously across the poll so a stall that lands
 * between two frames is still seen.
 *
 *   FT_MOCK_DIFF=8x6000 FT_MOCK_DIFF_CHURN=1 node scripts/mock-server.mjs 4471 &
 *   pnpm dev --port 5373 &
 *   MOCK_PORT=4471 DEV_PORT=5373 node scripts/churn.mjs
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

const browser = await chromium.launch({ channel: "chrome", args: ["--enable-precise-memory-info"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, colorScheme: "dark" });
page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 300)));
await page.addInitScript(([r]) => {
  window.localStorage.setItem("firetower.servers", r);
  window.localStorage.setItem("firetower.scope", "o_1");
}, [REGISTRY]);

/* Every byte the diff poll pulls down, counted, because it is paid twice: the
   sheet asks from the base and the tree asks from the last commit. */
let diffBytes = 0;
let diffCalls = 0;
page.on("response", async (r) => {
  if (!r.url().includes("/diff")) return;
  diffCalls++;
  diffBytes += Number(r.headers()["content-length"] ?? 0) || (await r.body().then((b) => b.length).catch(() => 0));
});

await page.goto(`http://localhost:${DEV}/#/sessions/w_1`, { waitUntil: "networkidle" });
await page.waitForTimeout(3000);

/* The navigation rail is an `aside` too, so the inspector is found by the one
   control only it has. */
const inspector = () => page.getByTitle("Hide the inspector");

const run = async (label, { diff }) => {
  /* `⌘\` toggles the inspector; it comes up open. */
  const shown = (await inspector().count()) > 0;
  if (diff !== shown) {
    await page.keyboard.press(process.platform === "darwin" ? "Meta+\\" : "Control+\\");
    await page.waitForTimeout(1500);
  }
  if (diff) {
    /* Reopening asks for the whole diff again from nothing, and that read plus
       the draw is not quick — so wait on the rows appearing and say how long
       they took, because that wait is itself part of the complaint. */
    const at = Date.now();
    await page.locator("button.group\\/file").first().waitFor({ timeout: 120_000 });
    if ((await page.locator(ROW).count()) === 0) {
      await page.locator("button.group\\/file").first().click();
    }
    await page.locator(ROW).first().waitFor({ timeout: 120_000 });
    await page.waitForTimeout(1500);
    console.log(`  (the pane took ${((Date.now() - at) / 1000).toFixed(1)}s to draw after it was opened)`);
  }
  diffBytes = 0;
  diffCalls = 0;

  await page.locator("textarea").first().click();
  /* A hand types about eight characters a second. Sampled for long enough to
     cover several eight-second polls. */
  const out = await page.evaluate(async (seconds) => {
    const el = document.querySelector("textarea");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    const each = [];
    const frames = [];
    let last = performance.now();
    let stop = false;
    const tick = (now) => {
      frames.push(now - last);
      last = now;
      if (!stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const until = performance.now() + seconds * 1000;
    while (performance.now() < until) {
      el.focus();
      const a = performance.now();
      setter.call(el, `${el.value}x`);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      each.push(performance.now() - a);
      await new Promise((d) => setTimeout(d, 125));
    }
    stop = true;
    const sorted = [...each].sort((x, y) => x - y);
    const at = (p) => +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(1);
    /* A frame that took longer than 100 ms is a visible hitch, whatever caused
       it — a long render, a parse, or a collection. */
    const hitches = frames.filter((f) => f > 100);
    return {
      keys: each.length,
      p50: at(0.5),
      p95: at(0.95),
      worst: +sorted[sorted.length - 1].toFixed(1),
      hitches: hitches.length,
      longest: +Math.max(0, ...frames).toFixed(0),
      heapMb: +(performance.memory.usedJSHeapSize / 1e6).toFixed(1),
      nodes: document.getElementsByTagName("*").length,
    };
  }, SECONDS);

  console.log(
    `${label.padEnd(22)} heap ${String(out.heapMb).padStart(6)} MB  nodes ${String(out.nodes).padStart(6)}  ` +
      `keystroke p50 ${String(out.p50).padStart(5)}  p95 ${String(out.p95).padStart(6)}  worst ${String(out.worst).padStart(7)} ms  ` +
      `frames >100ms: ${String(out.hitches).padStart(3)} (longest ${String(out.longest).padStart(5)} ms)  ` +
      `diff pulled ${(diffBytes / 1e6).toFixed(1)} MB in ${diffCalls} calls`,
  );
};

await run("inspector closed", { diff: false });
await run("diff pane open", { diff: true });

await browser.close();
