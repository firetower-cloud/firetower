/**
 * What the inspector costs to draw, measured rather than argued about.
 *
 * Drives the dev build against `mock-server.mjs` running with `FT_MOCK_DIFF`
 * set, and reports the three numbers that matter for issue #198: the JS heap,
 * the number of DOM nodes, and how long a keystroke in the composer takes.
 *
 *   FT_MOCK_DIFF=12x900 pnpm mock &   pnpm dev &   node scripts/weigh.mjs
 *
 * Chrome is driven with `--enable-precise-memory-info` so `usedJSHeapSize` is
 * a real number rather than the 100 KB-bucketed one pages normally see.
 */
import { chromium } from "playwright-core";

/* A drawn diff row. `[data-row]` is the windowed pane; `.group/line` is what it
   replaced, kept so this can still measure a checkout from before the change. */
const ROW = "[data-row], .group\\/line";


/* Ports are shared with everything else on this machine, so both are given. */
const MOCK = Number(process.env.MOCK_PORT ?? 4401);
const DEV = Number(process.env.DEV_PORT ?? 5273);

const REGISTRY = JSON.stringify([
  { url: `http://localhost:${MOCK}`, serverId: "o_1", org: "Acme", user: "kevin", token: "tok", addedAt: "2026-09-21T09:00:00Z" },
]);

const browser = await chromium.launch({
  channel: "chrome",
  args: ["--enable-precise-memory-info", "--js-flags=--expose-gc"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, colorScheme: "dark" });
page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 300)));

await page.addInitScript(([registry]) => {
  window.localStorage.setItem("firetower.servers", registry);
  window.localStorage.setItem("firetower.scope", "o_1");
}, [REGISTRY]);

await page.goto(`http://localhost:${DEV}/#/sessions/w_1`, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);

/** Heap and node count, after a collection so the number is what is held. */
const weigh = async () => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
  await cdp.detach().catch(() => {});
  await page.waitForTimeout(400);
  return page.evaluate((row) => ({
    heapMb: +(performance.memory.usedJSHeapSize / 1e6).toFixed(1),
    nodes: document.getElementsByTagName("*").length,
    svgs: document.getElementsByTagName("svg").length,
    diffRows: document.querySelectorAll(row).length,
  }), ROW);
};

/**
 * How long the composer takes to accept a character.
 *
 * Two numbers, because they fail for different reasons. `react` is the
 * synchronous work the keystroke forces — React 19 flushes a discrete input
 * event before the handler returns, so this is the whole re-render. `layout` is
 * what the composer's autosize effect then costs: it writes `height: 0` and
 * reads `scrollHeight`, and reading a geometry property after a style write
 * makes the browser lay out the *entire* document before it can answer.
 *
 * Twelve of them; the median and the worst, because typing is only as good as
 * its slowest letter.
 */
const typing = async () => {
  await page.locator("textarea").first().click();
  const each = [];
  for (let i = 0; i < 12; i++) {
    each.push(
      await page.evaluate(() => {
        const el = document.querySelector("textarea");
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
        el.focus();
        const a = performance.now();
        setter.call(el, `${el.value}x`);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        const b = performance.now();
        /* The autosize effect, done by hand, so its cost is separable. */
        el.style.height = "0px";
        void el.scrollHeight;
        const c = performance.now();
        return { react: b - a, layout: c - b };
      }),
    );
  }
  const pick = (k) => {
    const v = each.map((e) => e[k]).sort((x, y) => x - y);
    return { median: +v[6].toFixed(1), worst: +v[v.length - 1].toFixed(1) };
  };
  return { react: pick("react"), layout: pick("layout") };
};

const say = (label, m, t) =>
  console.log(
    `${label.padEnd(30)} heap ${String(m.heapMb).padStart(6)} MB  nodes ${String(m.nodes).padStart(6)}  svg ${String(m.svgs).padStart(5)}  rows ${String(m.diffRows).padStart(6)}  keystroke: react ${String(t.react.median).padStart(5)}/${String(t.react.worst).padEnd(5)} layout ${String(t.layout.median).padStart(5)}/${String(t.layout.worst).padEnd(5)} ms`,
  );

/* Inspector hidden — the floor. `⌘\` is the toggle. */
await page.keyboard.press(process.platform === "darwin" ? "Meta+\\" : "Control+\\");
await page.waitForTimeout(1200);
say("inspector closed", await weigh(), await typing());

/* Inspector open on the diff, first file expanded — which it is by default. */
await page.keyboard.press(process.platform === "darwin" ? "Meta+\\" : "Control+\\");
await page.waitForTimeout(2000);
say("diff open, 1 file expanded", await weigh(), await typing());

/* Each file opened in turn — reviewing a day of work. Only one is expanded at
   a time, so what this shows is what the pane holds on to afterwards. */
const rows = page.locator("aside button.group\\/file");
const n = await rows.count();
for (let i = 0; i < n; i++) {
  await rows.nth(i).click();
  await page.waitForTimeout(150);
}
await page.waitForTimeout(1500);
say(`after opening all ${n} in turn`, await weigh(), await typing());

/* And what eight seconds of polling does to it: the refetch interval. */
const before = await weigh();
await page.waitForTimeout(26_000);
const after = await weigh();
console.log(
  `three refetches later:         heap ${before.heapMb} MB → ${after.heapMb} MB (${after.heapMb - before.heapMb >= 0 ? "+" : ""}${(after.heapMb - before.heapMb).toFixed(1)})`,
);

await browser.close();
