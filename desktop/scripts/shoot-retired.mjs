/**
 * The surfaces the retired machine touches, photographed.
 *
 * A sibling of `shoot.mjs` — same Chrome, same 1440×900 at 2×, same dark —
 * driven against `mock-retired.mjs` rather than `mock-server.mjs`, because
 * these screens want a fleet that is empty and a session whose machine is not
 * in the fleet at all.
 *
 *   node scripts/mock-retired.mjs 4471 &
 *   pnpm dev --port 5373 &
 *   OUT=… API=http://localhost:4471 APP=http://localhost:5373 node scripts/shoot-retired.mjs
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const OUT = process.env.OUT ?? new URL("../../../.firetower/screenshots", import.meta.url).pathname;
const API = process.env.API ?? "http://localhost:4471";
const APP = process.env.APP ?? "http://localhost:5373";
mkdirSync(OUT, { recursive: true });

const REGISTRY = JSON.stringify([
  { url: API, serverId: "o_1", org: "Acme", user: "kevin", token: "tok", addedAt: "2026-11-01T09:00:00Z" },
]);

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark" });
page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 300)));
page.on("console", (m) => m.type() === "error" && console.log("console.error:", m.text().slice(0, 200)));

await page.addInitScript(([registry]) => {
  window.localStorage.setItem("firetower.servers", registry);
  window.localStorage.setItem("firetower.scope", "o_1");
}, [REGISTRY]);

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("shot", name);
};
const scene = async (s) => {
  await page.request.post(`${API}/__scene?s=${s}`);
};
/* A hard reload every time. `page.goto` to a URL that differs only in its
   hash is a same-document navigation: React state and the query cache both
   survive it, so a scene change made between two `goto`s is not read and the
   screen photographed is the previous scene's. */
const go = async (hash, wait = 1200) => {
  await page.goto(`${APP}/#${hash}`, { waitUntil: "networkidle" });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(wait);
};
/** A hash change inside the running app, without a reload losing the cache. */
const hop = async (hash, wait = 900) => {
  await page.evaluate((h) => { window.location.hash = h; }, hash);
  await page.waitForTimeout(wait);
};
const clearDismissals = async () => {
  await page.evaluate(() => {
    for (const k of Object.keys(window.localStorage)) {
      if (k.startsWith("firetower.removed.")) window.localStorage.removeItem(k);
    }
  });
};

/* ── A fresh install ─────────────────────────────────────────────────────
   No machine, nothing retired. AC1's empty state, AC12's dead end and
   AC15's save-anyway all live here. */
await scene("empty");
await go("/configuration/machines", 1600);
await shot("01-compute-empty-fleet");

// AC12 — NewPage's machine picker, the one of the three that a screen mounts.
await hop("/new", 1400);
await page.getByRole("button", { name: /Where it runs/ }).click();
await page.waitForTimeout(600);
await shot("02-picker-newpage-empty-fleet");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// AC15 — the connect-a-repository form with nothing to probe with.
await hop("/configuration/repositories", 1500);
await shot("03-repositories-empty-fleet");
for (const name of [/Connect a repository/i, /by URL/i, /Paste/i, /Add a repository/i]) {
  const b = page.getByRole("button", { name }).first();
  if (await b.count()) {
    await b.click().catch(() => {});
    await page.waitForTimeout(500);
    break;
  }
}
await shot("04-connect-repo-step-1");

/* ── The machine that is gone ────────────────────────────────────────────
   One ssh machine in the fleet, one retired machine behind it with two
   chores and two sessions. */
await scene("retired");
await go("/configuration/machines", 1800);
await clearDismissals();
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1600);
await shot("05-compute-notice-both-registers");

await page.getByRole("button", { name: /Show what pointed at it/ }).click();
await page.waitForTimeout(600);
await shot("06-compute-notice-detail-open");

await page.getByRole("button", { name: /Show what was running/ }).click();
await page.waitForTimeout(600);
await shot("07-compute-notice-sessions-listed");

// The persistent line must survive `Hide this` — and still open them.
await page.getByRole("button", { name: /^Hide this$/ }).click();
await page.waitForTimeout(700);
await shot("08-compute-notice-dismissed-line-survives");

const showThem = page.getByRole("button", { name: /^Show them$/ });
if (await showThem.count()) {
  await showThem.first().click();
  await page.waitForTimeout(700);
  await shot("09-compute-dismissed-show-them-pressed");
}

/* With no chore left the notice stops rendering by itself, which is the other
   way into the state above — and here the line's own click-through works. */
await scene("norecord");
await go("/configuration/machines", 1800);
await shot("10-compute-ssh-machine-and-persistent-line");
const showThem2 = page.getByRole("button", { name: /^Show them$/ });
if (await showThem2.count()) {
  await showThem2.first().click();
  await page.waitForTimeout(700);
  await shot("11-compute-no-chores-show-them-works");
}

/* ── A workspace whose machine is gone ───────────────────────────────────
   AC14 and AC17: the status bar, the rail, the card and the composer. */
await scene("retired");
await go("/sessions/s_auth", 2600);
await shot("12-workspace-machine-gone");

// The composer, close up — the placeholder is the whole of the claim.
const composer = page.locator("textarea").first();
if (await composer.count()) {
  const box = await composer.boundingBox();
  if (box) {
    await page.screenshot({
      path: `${OUT}/13-composer-disabled-machine-gone.png`,
      clip: { x: Math.max(0, box.x - 20), y: Math.max(0, box.y - 60), width: Math.min(1440 - box.x + 20, box.width + 40), height: box.height + 90 },
    });
    console.log("shot 13-composer-disabled-machine-gone");
  }
  // Typing into it: a disabled box must swallow nothing.
  await composer.click({ force: true }).catch(() => {});
  await composer.type("can I still send this?", { delay: 10 }).catch(() => {});
  await page.waitForTimeout(400);
  await shot("14-composer-typing-refused");
}

// A workspace on the machine that is still here, for the comparison.
await hop("/sessions/s_live", 2400);
await shot("15-workspace-machine-present-for-comparison");

/* ── The two screens that only worked because a machine existed ──────── */
await hop("/updates", 1800);
await shot("16-updates-control-plane-row");

await hop("/setup", 1400);
await shot("17-setup-final-screen");

/* ── A narrow viewport, since this is a resizable window ─────────────── */
await page.setViewportSize({ width: 820, height: 900 });
await scene("retired");
await go("/configuration/machines", 1800);
await clearDismissals();
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await shot("18-compute-notice-narrow-820");
await hop("/sessions/s_auth", 2400);
await shot("19-workspace-machine-gone-narrow-820");

await browser.close();
console.log("done");
