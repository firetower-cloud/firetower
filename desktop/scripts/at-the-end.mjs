/**
 * What the bottom of the transcript *reads* as, when you are actually at it.
 *
 *   node scripts/mock-server.mjs 4487 &
 *   pnpm dev --port 5387 &
 *   MOCK_PORT=4487 DEV_PORT=5387 node scripts/at-the-end.mjs
 *
 * `ui/follow.ts` takes hold of the end again only when somebody arrives at
 * it, and "arrived" has to be a number. The obvious one is zero and the
 * obvious one is wrong: `scrollHeight` and `clientHeight` are integers off
 * the CSSOM while `scrollTop` is a double, so `scrollHeight - scrollTop -
 * clientHeight` has two roundings in it that need not cancel, and a rule that
 * insisted on exactly 0 could leave somebody unable to re-follow at all —
 * silently, and only on their machine.
 *
 * The first answer to that was two pixels, and two pixels is a place you can
 * stop: a review scrolled up 400, back down 399, and watched the next thing
 * the agent wrote take the viewport the remaining 501px. So the tolerance has
 * to be *sub-pixel*, and whether a sub-pixel tolerance is enough is a
 * question about Chrome and the layout rather than about this code.
 *
 * Hence this. Nothing here fixes anything — it drives the real app, arrives
 * at the real end, and prints what the arithmetic says, over every device
 * scale a display is likely to have and a spread of odd and even window
 * heights. The number in `END` is whatever this says, plus headroom.
 *
 * ## What it found, 16 November 2026
 *
 *   arrival, by hand and by write      0.000, in all 360 readings
 *   half a pixel short                 0.000 — the browser snaps it back,
 *                                      so it is not a place the scroller sits
 *   one pixel short                    1.000, every time
 *
 * So every tolerance in `(0, 1)` behaves identically, and `END` is half a
 * pixel: the middle of that band, unable to swallow a whole pixel, and able
 * to absorb a sub-pixel residual another webview might produce. The app has
 * no page zoom (`bridge.zoom` is the *window's*), which is the condition
 * measured here; under CSS zoom the arithmetic drifts past a pixel and no
 * constant would be right.
 */
const MOCK = Number(process.env.MOCK_PORT ?? 4401);
const DEV = Number(process.env.DEV_PORT ?? 5273);
process.env.HERE ??= `http://localhost:${MOCK}`;
process.env.APP ??= `http://localhost:${DEV}`;

import { chromium } from "playwright-core";

const REGISTRY = JSON.stringify([
  { url: `http://localhost:${MOCK}`, serverId: "o_1", org: "Acme", user: "kevin", token: "tok", addedAt: "2026-09-21T09:00:00Z" },
]);

/** Every display scale a Mac or a Windows machine is likely to report. */
const SCALES = [1, 1.25, 1.5, 2, 2.5, 3];
/** Odd and even, because half a window height is where a fraction comes from. */
const HEIGHTS = [703, 760, 800, 820, 823, 824, 825, 900, 901, 1013];
/** The turn finished, the turn open, and the turn open with a question — the
    last two have the per-frame pin running, which is visible in the readings
    below the end: it puts anybody it finds short of it back. */
const SCENES = ["scroll-idle", "scroll-working", "scroll-asking"];

const browser = await chromium.launch({ channel: "chrome" });
const rows = [];

for (const scene of SCENES) {
  for (const dpr of SCALES) {
    for (const height of HEIGHTS) {
      const page = await browser.newPage({ viewport: { width: 1280, height }, deviceScaleFactor: dpr });
      await page.addInitScript(
        ([registry]) => {
          window.localStorage.setItem("firetower.servers", registry);
          window.localStorage.setItem("firetower.current", "o_1");
          window.localStorage.setItem("firetower.theme", "dark");
        },
        [REGISTRY],
      );
      await page.request.post(`${process.env.HERE}/__reset?scene=${scene}`);
      await page.goto(`${process.env.APP}/#/sessions/s_1`, { waitUntil: "networkidle" });
      await page.waitForSelector("h1.text-display");
      await page.waitForTimeout(1300);

      /* Arrived the way a person does: overscroll downwards and let the
         browser clamp. Not by writing, which is the app's own way and could
         flatter itself. */
      const box = await page.evaluate(() => {
        const { x, y, width, height } = document.querySelector("h1.text-display").closest(".overflow-y-auto").getBoundingClientRect();
        return { x: x + width / 2, y: y + height / 2 };
      });
      await page.mouse.move(box.x, box.y);
      await page.mouse.wheel(0, -900);
      await page.waitForTimeout(250);
      await page.mouse.wheel(0, 9000);
      await page.waitForTimeout(500);

      rows.push({
        scene,
        dpr,
        height,
        ...(await page.evaluate(async () => {
          const el = document.querySelector("h1.text-display").closest(".overflow-y-auto");
          const gap = () => el.scrollHeight - el.scrollTop - el.clientHeight;
          const frame = () => new Promise((r) => requestAnimationFrame(r));
          const byHand = gap();
          el.scrollTop = el.scrollHeight;
          await frame();
          const written = gap();
          const max = el.scrollTop;
          /* Short of it, by less than the browser will hold and by exactly
             one pixel. */
          el.scrollTop = max - 0.5;
          await frame();
          const half = gap();
          el.scrollTop = max - 1;
          await frame();
          const one = gap();
          return { byHand, written, half, one };
        })),
      });
      await page.close();
    }
  }
}

await browser.close();

const f = (n) => (Math.round(n * 1000) / 1000).toFixed(3);
const pad = (s, n) => String(s).padEnd(n);

console.log(`\n  No page zoom · ${SCENES.length} scenes × ${SCALES.length} device scales × ${HEIGHTS.length} window heights\n`);
console.log("  scene            scale  height   arrived by hand   written past it   half short   one short");
for (const r of rows)
  console.log(
    `  ${pad(r.scene, 16)} ${pad(r.dpr, 6)} ${pad(r.height, 8)} ${f(r.byHand).padStart(15)} ${f(r.written).padStart(17)} ${f(r.half).padStart(12)} ${f(r.one).padStart(11)}`,
  );

const span = (label, xs) => console.log(`  ${pad(label, 32)} min ${f(Math.min(...xs)).padStart(7)}   max ${f(Math.max(...xs)).padStart(7)}`);
const arrivals = [...rows.map((r) => r.byHand), ...rows.map((r) => r.written)];
console.log(`\n  ${rows.length} configurations, ${arrivals.length} arrivals\n`);
span("at the end", arrivals);
span("half a pixel short", rows.map((r) => r.half));
span("one pixel short", rows.map((r) => r.one));

console.log("");
/* `below(e) < END` is the rule, so each candidate is read that way. Demanding
   exactly 0 is the one that cannot be written as a threshold at all, and it
   is reported on its own terms: it happens to be right everywhere here, and
   it is right with no headroom whatever — which is the whole argument for a
   tolerance, since this is Chrome and the app ships in a webview nobody has
   measured. */
const exact = arrivals.filter((n) => n !== 0).length;
console.log(`  demanding exactly 0:  arrivals it would not notice ${String(exact).padStart(4)}/${arrivals.length}, and no headroom at all`);
for (const end of [0.25, 0.5, 0.75, 1]) {
  const missed = arrivals.filter((n) => !(n < end)).length;
  const swallowed = rows.filter((r) => r.one < end).length;
  console.log(
    `  below < ${pad(end, 5)} arrivals it would not notice ${String(missed).padStart(4)}/${arrivals.length}   one-pixel-short it would take as the end ${String(swallowed).padStart(4)}/${rows.length}`,
  );
}
console.log("");
