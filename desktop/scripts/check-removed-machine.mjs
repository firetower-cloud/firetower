/**
 * The two controls that open the sessions from a removed machine, pressed.
 *
 * `removed-machine.test.ts` covers the decision — `toggled()` is pure and its
 * cases are named there. This covers the *press*: the desktop suite is
 * `renderToStaticMarkup` and pure functions, so nothing in it clicks
 * anything, and the defect this exists to catch was invisible to that kind of
 * test. A control read "Hide them" while nothing was on screen, because a
 * second predicate in the JSX disagreed with the state.
 *
 * So each step asserts both halves together: what the control says, and
 * whether a session row is actually drawn. A label that disagrees with the
 * screen fails here.
 *
 * Exits non-zero if any assertion fails, so it can be run as a check.
 *
 *   node scripts/mock-retired.mjs 4471 &
 *   pnpm dev --port 5373 &
 *   OUT=/tmp/shots API=http://localhost:4471 APP=http://localhost:5373 \
 *     node scripts/check-removed-machine.mjs
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const OUT = process.env.OUT;
const API = process.env.API;
const APP = process.env.APP;
mkdirSync(OUT, { recursive: true });

const REGISTRY = JSON.stringify([
  { url: API, serverId: "o_1", org: "Acme", user: "kevin", token: "tok", addedAt: "2026-11-01T09:00:00Z" },
]);

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark" });
page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 200)));
await page.addInitScript(([r]) => {
  window.localStorage.setItem("firetower.servers", r);
  window.localStorage.setItem("firetower.scope", "o_1");
}, [REGISTRY]);

const shot = async (n) => { await page.screenshot({ path: `${OUT}/${n}.png` }); console.log("   shot", n); };
const scene = async (s) => page.request.post(`${API}/__scene?s=${s}`);
const go = async (hash, wait = 1700) => {
  await page.goto(`${APP}/#${hash}`, { waitUntil: "networkidle" });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(wait);
};
const press = async (name) => {
  await page.getByRole("button", { name }).first().click();
  await page.waitForTimeout(700);
};
/** How many session rows are actually drawn, and where each one sits. */
const rows = () => page.getByRole("button", { name: /Move session tokens onto the new signing key/ }).count();
/** Which labels the two controls are showing right now. */
const labels = async () => {
  const of = async (re) => ((await page.getByRole("button", { name: re }).count()) > 0 ? re.source : null);
  return {
    notice: (await of(/^Show what was running$/)) ? "Show what was running" : (await of(/^Hide what was running$/)) ? "Hide what was running" : "(absent)",
    foot: (await of(/^Show them$/)) ? "Show them" : (await of(/^Hide them$/)) ? "Hide them" : "(absent)",
  };
};
const state = async (what) => {
  const n = await rows();
  const l = await labels();
  console.log(`   ${what}: rows=${n}  notice="${l.notice}"  foot="${l.foot}"`);
  return { n, l };
};
/** The screen with the notice un-dismissed, which `Hide this` persists. */
const undismissed = async (hash) => {
  await page.goto(`${APP}/#${hash}`, { waitUntil: "networkidle" });
  await page.evaluate(() => {
    for (const k of Object.keys(window.localStorage)) if (k.startsWith("firetower.removed.")) window.localStorage.removeItem(k);
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1700);
};
let bad = 0;
const expect = (ok, msg) => { if (!ok) { bad++; console.log(`   ✗ ${msg}`); } else console.log(`   ✓ ${msg}`); };

await scene("retired");

/* ── The original repro, exactly as it was reported ──────────────────── */
console.log("\n[1] the original repro — dismiss, then Show them");
await undismissed("/configuration/machines");

await press(/^Hide this$/);
let s = await state("after Hide this");
expect((await page.getByText(/sessions ran on/).count()) > 0, "the persistent line survives the dismissal");
expect(s.l.foot === "Show them", 'the line reads "Show them"');
expect(s.n === 0, "and no list is open yet");
await shot("50-FIXED-dismissed-line-says-show-them");

await press(/^Show them$/);
s = await state("after Show them");
expect(s.n === 1, "pressing it OPENS the sessions — the AC13 defect is fixed");
expect(s.l.foot === "Hide them", 'and the label now reads "Hide them", matching what is on screen');
await shot("51-FIXED-show-them-opens-the-sessions");

console.log("\n[2] pressing the same control again closes it");
await press(/^Hide them$/);
s = await state("after Hide them");
expect(s.n === 0, "the list closes");
expect(s.l.foot === "Show them", "and the label goes back");

/* ── The three-state toggle, with the notice visible ──────────────────── */
console.log("\n[3] with the notice visible — the list must MOVE, not draw twice");
// Part 1 pressed "Hide this", and that is remembered per machine on this Mac.
await undismissed("/configuration/machines");
s = await state("fresh, notice visible");
expect(s.l.notice === "Show what was running" && s.l.foot === "Show them", "both controls offer to show");

await press(/^Show what was running$/);
s = await state("opened from the notice");
expect(s.n === 1, "exactly one list, in the notice");
expect(s.l.notice === "Hide what was running", "the notice control reads Hide");
expect(s.l.foot === "Show them", "and the foot control still reads Show — it is not open there");
await shot("52-FIXED-open-in-the-notice");

await press(/^Show them$/);
s = await state("then pressed the foot control");
expect(s.n === 1, "STILL exactly one list — it moved rather than drawing twice");
expect(s.l.foot === "Hide them", "the foot control now reads Hide");
expect(s.l.notice === "Show what was running", "and the notice control went back to Show");
await shot("53-FIXED-list-moved-to-the-foot-not-doubled");

await press(/^Show what was running$/);
s = await state("and back again");
expect(s.n === 1, "one list, back in the notice");
expect(s.l.notice === "Hide what was running" && s.l.foot === "Show them", "labels follow it");

await press(/^Hide what was running$/);
s = await state("closed from the notice");
expect(s.n === 0, "closes");
expect(s.l.notice === "Show what was running" && s.l.foot === "Show them", "both labels back to Show");

/* ── And the case that always worked, still works ─────────────────────── */
console.log("\n[4] no chores — the line is the only control");
await scene("norecord");
await go("/configuration/machines");
s = await state("no chores");
expect(s.l.notice === "(absent)", "the notice is not rendered");
await press(/^Show them$/);
s = await state("after Show them");
expect(s.n === 1, "the line opens the sessions");
await shot("54-FIXED-no-chores-line-still-works");

console.log(`\n${bad === 0 ? "ALL CLICK-PATH ASSERTIONS PASSED" : `${bad} ASSERTION(S) FAILED`}`);
await browser.close();
process.exit(bad === 0 ? 0 : 1);
