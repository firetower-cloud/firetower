/**
 * The `@` list and a mention, photographed.
 *
 * Same arrangement as `shoot-agents.mjs`: the dev build in the Chrome already
 * on the machine, against `mock-server.mjs`, which answers the artifact list,
 * the posters and the mention itself — so there is no worker, no Postgres and
 * no agent in the way, and the composer is the real one.
 *
 *   node scripts/mock-server.mjs 4412 &
 *   pnpm dev --port 5299 --strictPort &
 *   MOCK=4412 APP=5299 node scripts/shoot-mention.mjs
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const MOCK = process.env.MOCK ?? "4412";
const APP = process.env.APP ?? "5299";
const OUT = process.env.OUT ?? "/tmp/ft-shots";
mkdirSync(OUT, { recursive: true });

const REGISTRY = JSON.stringify([
  { url: `http://localhost:${MOCK}`, serverId: "o_1", org: "Acme", user: "kevin", token: "tok", addedAt: "2026-09-21T09:00:00Z" },
]);

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, colorScheme: "dark" });
page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 300)));

await page.addInitScript(([registry]) => {
  window.localStorage.setItem("firetower.servers", registry);
  window.localStorage.setItem("firetower.scope", "o_1");
}, [REGISTRY]);

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("shot", name);
};

await page.request.post(`http://localhost:${MOCK}/__reset`);
await page.goto(`http://localhost:${APP}/#/sessions/w_1`, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

const box = page.getByPlaceholder("Say something to the agent");
await box.click();

// ── the list, as `@` opens it ─────────────────────────────────────────
await page.keyboard.type("Make it match @");
await page.waitForTimeout(900);
await shot("1-the-list");

// ── narrowed by what follows ──────────────────────────────────────────
await page.keyboard.type("pri");
await page.waitForTimeout(500);
await shot("2-filtered");

// ── picked: the chip waits while the page lands, then settles ─────────
await page.keyboard.press("Enter");
await page.waitForTimeout(250);
await shot("3-picked-on-its-way");
await page.waitForTimeout(1200);
await page.keyboard.type("— same type scale and the same button weight.");
await page.waitForTimeout(300);
await shot("4-picked");

// ── sent: the bubble draws the handle and the chip ────────────────────
await page.keyboard.press("Enter");
await page.waitForTimeout(900);
await shot("5-sent");

// ── escape leaves the sentence exactly as typed ───────────────────────
await page.keyboard.type("Compare it with @onb");
await page.waitForTimeout(500);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
await shot("6-escape-leaves-it");

// ── nothing in the library yet ────────────────────────────────────────
await page.request.post(`http://localhost:${MOCK}/__reset?scene=no-artifacts`);
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await box.click();
await page.keyboard.type("@");
await page.waitForTimeout(700);
await shot("7-no-artifacts-yet");

await browser.close();
console.log("done");
