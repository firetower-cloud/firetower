/**
 * The shell, photographed in both themes.
 *
 * The rail, the panel, the title bar, the switcher and the profile menu, in
 * light and in dark, against `mock-server.mjs` — so the one thing a rule
 * cannot tell you, *what it actually looks like*, can be looked at without a
 * worker and a Firetower to connect to.
 *
 *   pnpm mock &   pnpm dev &   pnpm shoot:shell
 *
 * Two Firetowers are registered rather than one, because half of what this
 * phase changed only exists with two: the two-letter mark, the switcher, the
 * dot on the avatar meaning *waiting somewhere you are not*, and an
 * unreachable row that has to stay dimmed and dashed rather than disappear.
 * The second address answers nothing, which is exactly the state the memo
 * expects to be the common one.
 *
 * `channel: "chrome"` on purpose: it drives the Chrome already on the machine
 * rather than downloading a browser, so `playwright-core` is the whole of the
 * dependency.
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const OUT = process.env.OUT ?? new URL("../../../.firetower/screenshots", import.meta.url).pathname;
const APP = process.env.APP ?? "http://localhost:5273";
mkdirSync(OUT, { recursive: true });

const REGISTRY = JSON.stringify([
  { url: "http://localhost:4401", serverId: "o_1", org: "Acme", user: "kevin", token: "tok", addedAt: "2026-09-21T09:00:00Z" },
  /* Nothing is listening here, which is the point. */
  { url: "http://localhost:4499", serverId: "o_2", org: "Apex", user: "kp", token: "tok", addedAt: "2026-09-22T09:00:00Z" },
]);

const browser = await chromium.launch({ channel: "chrome" });

for (const theme of ["light", "dark"]) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 824 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => console.log(`pageerror (${theme}):`, String(e).slice(0, 300)));

  await page.addInitScript(
    ([registry, choice]) => {
      window.localStorage.setItem("firetower.servers", registry);
      window.localStorage.setItem("firetower.current", "o_1");
      window.localStorage.setItem("firetower.theme", choice);
      window.localStorage.removeItem("firetower.panel");
    },
    [REGISTRY, theme],
  );

  const shot = async (name) => {
    await page.screenshot({ path: `${OUT}/shell-${theme}-${name}.png` });
    console.log("shot", `shell-${theme}-${name}`);
  };

  await page.goto(`${APP}/#/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await shot("1-dashboard");

  /* Hover a destination you are not in. The panel should swap without the
     sheet changing, after the 180ms the hysteresis costs. */
  await page.getByRole("button", { name: "Machines" }).hover();
  await page.waitForTimeout(500);
  await shot("2-peek");

  /* And focus has to do the same thing, or the rail is pointer-only. */
  await page.mouse.move(640, 700);
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Repositories" }).focus();
  await page.waitForTimeout(400);
  await shot("3-focus-previews");

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "You, and which Firetower you are in" }).click();
  await page.waitForTimeout(400);
  await shot("4-profile");

  await page.getByText("Switch Firetower").first().click();
  await page.waitForTimeout(400);
  await shot("5-switcher");

  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  /* ⌘4 is Customize. Pressed rather than clicked, because the keyboard map is
     half of what this phase is. */
  await page.keyboard.press("Meta+4");
  await page.waitForTimeout(800);
  await shot("6-customize");

  /* ⌘\ collapses the panel; the sheet should take the width. */
  await page.keyboard.press("Meta+\\");
  await page.waitForTimeout(500);
  await shot("7-collapsed");

  /* And a peek over a collapsed panel floats rather than pushing. */
  await page.getByRole("button", { name: "Tasks" }).hover();
  await page.waitForTimeout(600);
  await shot("8-floating");

  await page.goto(`${APP}/#/style`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/shell-${theme}-9-style.png`, fullPage: true });
  console.log("shot", `shell-${theme}-9-style`);

  await page.close();
}

await browser.close();
console.log(`\n  ${OUT}`);
