/**
 * The stale-agent screen and a Claude session's pickers, photographed.
 *
 * Same arrangement as `shoot.mjs`: the dev build in the Chrome already on the
 * machine, against `mock-server.mjs`, so there is no worker, no Postgres and
 * no subscription in the way. What the mock serves for these two screens is
 * what a real control plane produced — see the comments beside `AGENTS` and
 * `CLAUDE_CONTROLS` there.
 *
 *   node scripts/mock-server.mjs 4412 &
 *   pnpm dev --port 5299 --strictPort &
 *   MOCK=4412 APP=5299 node scripts/shoot-agents.mjs
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

// ── the Agents screen ────────────────────────────────────────────────

await page.goto(`http://localhost:${APP}/#/configuration`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
await shot("1-configuration");

// Expanding one is what shows the machines it is installed on.
await page.getByText("Claude Code", { exact: true }).first().click();
await page.waitForTimeout(700);
await shot("2-claude-code-behind");

// The fleet-wide press, and the confirmation it is behind.
await page.getByRole("button", { name: /Update all/ }).click();
await page.waitForTimeout(600);
await shot("3-update-all-confirm");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// Codex, left current, for the other half of the comparison.
await page.getByText("Claude Code", { exact: true }).first().click();
await page.waitForTimeout(300);
await page.getByText("Codex", { exact: true }).first().click();
await page.waitForTimeout(700);
await shot("4-codex-up-to-date");

// ── a Claude session's pickers ───────────────────────────────────────

await page.goto(`http://localhost:${APP}/#/sessions/w_1`, { waitUntil: "networkidle" });
await page.waitForTimeout(1800);
await shot("5-composer");

// The bug this half was for: the model picker drew the word "Model".
await page.getByRole("button", { name: /^Opus/ }).click();
await page.waitForTimeout(500);
await shot("6-model-picker");
// The picker closes on its own backdrop, not on Escape.
await page.locator("button.fixed.inset-0").click();
await page.waitForTimeout(400);

// Five levels, where there were four.
await page.getByRole("button", { name: /^Effort/ }).click();
await page.waitForTimeout(500);
await shot("7-effort-picker");

await browser.close();
console.log("done —", OUT);
