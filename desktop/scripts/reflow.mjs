/**
 * What the composer's autosize costs, as a function of how big the page is.
 *
 * `Composer.tsx` sizes the textarea to its content on every edit: it writes
 * `height: 0` and then reads `scrollHeight`. Reading a geometry property after
 * a style write makes the browser lay the document out before it can answer, so
 * the price of one keystroke is the price of laying out everything on screen.
 *
 * Usually that is nothing, because the layout is already clean. It is not
 * nothing right after the diff poll has replaced thousands of rows. This
 * measures both: a clean layout, and one dirtied the way a poll dirties it.
 *
 *   MOCK_PORT=4471 DEV_PORT=5374 node scripts/reflow.mjs
 */
import { chromium } from "playwright-core";

/* A drawn diff row. `[data-row]` is the windowed pane; `.group/line` is what it
   replaced, kept so this can still measure a checkout from before the change. */
const ROW = "[data-row], .group\\/line";


const MOCK = Number(process.env.MOCK_PORT ?? 4401);
const DEV = Number(process.env.DEV_PORT ?? 5273);

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

await page.goto(`http://localhost:${DEV}/#/sessions/w_1`, { waitUntil: "networkidle" });
await page.waitForTimeout(4000);

/**
 * The autosize, timed, twelve times over.
 *
 * `dirty` retouches every diff row's text first — which is what the poll does
 * when the agent has edited the file — so the forced layout has real work.
 */
const measure = (dirty) =>
  page.evaluate(([dirty, row]) => {
    const el = document.querySelector("textarea");
    const rows = [...document.querySelectorAll(row)];
    const each = [];
    for (let i = 0; i < 12; i++) {
      if (dirty) for (const r of rows) r.style.paddingLeft = `${i % 2}px`;
      const a = performance.now();
      el.style.height = "0px";
      void el.scrollHeight; // the browser must lay out the page to answer
      each.push(performance.now() - a);
    }
    const v = each.sort((x, y) => x - y);
    return { rows: rows.length, median: +v[6].toFixed(1), worst: +v[v.length - 1].toFixed(1) };
  }, [dirty, ROW]);

const say = async (label) => {
  const clean = await measure(false);
  const dirty = await measure(true);
  console.log(
    `${label.padEnd(20)} rows ${String(clean.rows).padStart(6)}   autosize on a clean layout ${String(clean.median).padStart(5)} ms   ` +
      `after the rows change ${String(dirty.median).padStart(6)} ms (worst ${dirty.worst})`,
  );
};

await page.getByTitle("Hide the inspector").waitFor();
await page.locator(ROW).first().waitFor({ timeout: 60_000 });
await say("diff pane open");

await page.keyboard.press(process.platform === "darwin" ? "Meta+\\" : "Control+\\");
await page.waitForTimeout(1500);
await say("inspector closed");

await browser.close();
