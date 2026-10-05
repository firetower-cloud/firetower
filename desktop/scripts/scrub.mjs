/**
 * That the windowed diff shows the right lines, not just fewer of them.
 *
 * Scrubs the pane from top to bottom and checks, at each stop, that the row
 * under the top edge is the one the patch has at that position — so an
 * off-by-one in the spacers, or a window that lags the scroll, fails here
 * rather than in somebody's review.
 *
 *   FT_MOCK_DIFF=8x6000 node scripts/mock-server.mjs 4471 &
 *   MOCK_PORT=4471 DEV_PORT=5374 node scripts/scrub.mjs
 */
import { chromium } from "playwright-core";

const MOCK = Number(process.env.MOCK_PORT ?? 4401);
const DEV = Number(process.env.DEV_PORT ?? 5273);

const REGISTRY = JSON.stringify([
  { url: `http://localhost:${MOCK}`, serverId: "o_1", org: "Acme", user: "kevin", token: "tok", addedAt: "2026-09-21T09:00:00Z" },
]);

/* The same reading of the patch the app does, so the two can be compared. */
const fromPatch = (patch) =>
  patch
    .replace(/\n$/, "")
    .split("\n")
    .filter((l) => !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index|rename from|rename to)/.test(l))
    .map((l) => {
      if (l.startsWith("@@")) return ["hunk", l];
      if (l.startsWith("+")) return ["add", l.slice(1)];
      if (l.startsWith("-")) return ["del", l.slice(1)];
      return ["ctx", l.replace(/^ /, "")];
    });

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, colorScheme: "dark" });
page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 300)));
await page.addInitScript(([r]) => {
  window.localStorage.setItem("firetower.servers", r);
  window.localStorage.setItem("firetower.scope", "o_1");
}, [REGISTRY]);

const diff = await fetch(`http://localhost:${MOCK}/api/v1/sessions/s_1/diff`).then((r) => r.json());
const want = fromPatch(diff[0].patch);
console.log(`${diff[0].path}: ${want.length} rows in the patch\n`);

await page.goto(`http://localhost:${DEV}/#/sessions/w_1`, { waitUntil: "networkidle" });
await page.getByTitle("Hide the inspector").waitFor();
await page.locator("[data-row]").first().waitFor({ timeout: 60_000 });

/* The inspector's own scroller. The navigation rail is an `aside` that scrolls
   too, and it comes first in the document. */
const pane = page.locator('aside:has([title="Hide the inspector"]) > div.overflow-y-auto').first();

/** Every row in the document right now, by its index, with its text. */
const drawn = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-row]")].map((r) => [
      Number(r.dataset.row),
      r.children[1].textContent,
      r.getBoundingClientRect().top,
    ]),
  );

let bad = 0;
const reach = await pane.evaluate((el) => el.scrollHeight - el.clientHeight);
console.log(`the pane scrolls ${reach}px\n   at   drawn   first..last   the row under the top edge`);

for (const part of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
  const to = Math.round(reach * part);
  await pane.evaluate((el, to) => el.scrollTo({ top: to }), to);
  await page.waitForTimeout(350);
  const rows = await drawn();
  const top = await pane.evaluate((el) => el.getBoundingClientRect().top);

  /* The first row whose bottom is below the pane's top edge: what the eye sees
     at the top of the view. */
  const seen = rows.filter(([, , y]) => y >= top - 1).sort((a, b) => a[2] - b[2])[0];
  const first = rows.length ? Math.min(...rows.map((r) => r[0])) : -1;
  const last = rows.length ? Math.max(...rows.map((r) => r[0])) : -1;

  /* Every drawn row must carry the text the patch has at its index. */
  const wrong = rows.filter(([i, text]) => want[i] && want[i][1] !== text);
  /* And the window must actually cover the top edge. */
  const covered = seen !== undefined;
  if (wrong.length || !covered) bad++;

  console.log(
    `${String(Math.round(part * 100)).padStart(5)}% ${String(rows.length).padStart(7)}   ${String(first).padStart(5)}..${String(last).padEnd(6)} ` +
      `${covered ? `row ${String(seen[0]).padStart(5)}  ${JSON.stringify((seen[1] ?? "").slice(0, 44))}` : "NOTHING DRAWN AT THE TOP EDGE"}` +
      `${wrong.length ? `   ${wrong.length} ROWS WITH THE WRONG TEXT` : ""}`,
  );
}

/* The last row of the patch has to be reachable, or the diff silently ends early. */
await pane.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
await page.waitForTimeout(400);
const end = await drawn();
const reached = Math.max(...end.map((r) => r[0]));
console.log(`\nscrolled to the bottom: last row drawn is ${reached}, the patch ends at ${want.length - 1}`);
if (reached !== want.length - 1) {
  bad++;
  console.log("  THE END OF THE DIFF IS NOT REACHABLE");
}

/* The hover control: one in the document, on the row under the pointer. */
const row = page.locator("[data-row]").nth(5);
await row.hover();
await page.waitForTimeout(200);
const controls = await page.locator('[data-row] button[title="Ask for a change here"]').count();
console.log(`hovering a row: ${controls} "ask for a change" control in the pane`);
if (controls !== 1) {
  bad++;
  console.log("  EXPECTED EXACTLY ONE");
}

console.log(bad === 0 ? "\nall good" : `\n${bad} checks failed`);
await browser.close();
process.exit(bad === 0 ? 0 : 1);
