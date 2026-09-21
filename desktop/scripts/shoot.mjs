/**
 * The workspace's repositories, photographed.
 *
 * Drives the dev build in Chrome against `mock-server.mjs`, so the panel, the
 * picker and the card in the transcript can be looked at without a worker and
 * a machine with repositories on it. Screenshots land in the workspace's
 * `.firetower/screenshots`, which is where they can actually be read.
 *
 *   pnpm mock &   pnpm dev &   pnpm shoot
 *
 * `channel: "chrome"` on purpose: it drives the Chrome already on the machine
 * rather than downloading a browser, so `playwright-core` is the whole of the
 * dependency and `playwright install` is not a step anybody has to know about.
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const OUT = process.env.OUT ?? new URL("../../../.firetower/screenshots", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const REGISTRY = JSON.stringify([
  { url: "http://localhost:4401", serverId: "o_1", org: "Acme", user: "kevin", token: "tok", addedAt: "2026-09-21T09:00:00Z" },
]);

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark" });

page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 300)));

await page.addInitScript(([registry]) => {
  window.localStorage.setItem("firetower.servers", registry);
  window.localStorage.setItem("firetower.scope", "o_1");
}, [REGISTRY]);

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("shot", name);
};

/* The mock keeps what previous runs checked in, so start from a workspace
   that has just come up — otherwise a second run finds the repositories it
   was about to add already there, and every locator misses. */
await page.request.post("http://localhost:4401/__reset");

await page.goto("http://localhost:5273/#/sessions/w_1", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await shot("1-workspace");

const chip = page.getByTitle("Repositories in this workspace");
await chip.click();
await page.waitForTimeout(600);
await shot("2-what-is-checked-out");

await page.getByText("Add a repository to this workspace").click();
await page.waitForTimeout(400);
await shot("3-the-picker");

// Three in one go, one of which the host will refuse.
await page.getByRole("button", { name: /acme\/design-system/ }).click();
await page.getByRole("button", { name: /acme\/docs/ }).click();
await page.getByRole("button", { name: /acme\/mobile/ }).click();
await page.waitForTimeout(300);
await shot("4-three-chosen");

// The base branch: the row's own branch, pressed.
await page.getByTitle("The branch to cut from").first().click();
await page.waitForTimeout(200);
await page.keyboard.type("release/2026-09");
await page.waitForTimeout(200);
await shot("5-cut-from-another-branch");
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
await shot("6-base-chosen");

await page.getByRole("button", { name: /^Check in/ }).click();
await page.waitForTimeout(2600);
await shot("7-checking-in");

await page.waitForTimeout(5000);
await shot("8-two-in-one-refused");

// The card on its own, with the panel out of the way.
await page.keyboard.press("Escape");
await page.mouse.click(1100, 700);
await page.waitForTimeout(600);
await shot("9-the-card-in-the-conversation");

// A run where everything lands folds itself away, like the bring-up does.
await chip.click();
await page.waitForTimeout(400);
await page.getByText("Add a repository to this workspace").click();
await page.waitForTimeout(300);
await page.getByRole("button", { name: /acme\/jobs/ }).click();
await page.getByRole("button", { name: /^Check in/ }).click();
await page.waitForTimeout(3500);
await page.mouse.click(1100, 700);
await page.waitForTimeout(600);
await shot("10-a-clean-run-folds");

/* ── Nothing refused ─────────────────────────────────────────────────────
   The same three repositories, on a workspace put back to how it came up,
   with the one the host refuses left out. */
await page.request.post("http://localhost:4401/__reset");
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1200);

await chip.click();
await page.waitForTimeout(400);
await page.getByText("Add a repository to this workspace").click();
await page.waitForTimeout(300);
await page.getByRole("button", { name: /acme\/design-system/ }).click();
await page.getByRole("button", { name: /acme\/mobile/ }).click();
await page.getByRole("button", { name: /acme\/jobs/ }).click();
await page.getByRole("button", { name: /^Check in/ }).click();
await page.waitForTimeout(4400);
await shot("11-all-three-landing");

await page.waitForTimeout(3200);
await shot("12-all-three-in-the-panel");

await page.mouse.click(1100, 700);
await page.waitForTimeout(700);
await shot("13-folded-to-a-line");

await page.getByText(/repositories checked in/).click();
await page.waitForTimeout(500);
await shot("14-opened-again");

await browser.close();
console.log("done");
