/**
 * The connector screens, photographed against a **real** control plane.
 *
 *   # the demo leaves one running, with real connectors in it
 *   FTDEMO_KEEP=1 ./docs/connectors-demo.py
 *   pnpm --dir desktop dev --port 5293 &
 *   HERE=http://127.0.0.1:14911 TOKEN=$(cat /tmp/ftdemo/token) \
 *     APP=http://localhost:5293 node desktop/scripts/shoot-connectors.mjs
 *
 * **Against the real server, not the mock**, which is the whole point. Every
 * tool list, scope list and version in these shots came off Google Drive,
 * Canva and a conformant authorization server over the network a moment
 * before the shutter — so what they show is what the build does rather than
 * what a fixture says it does.
 *
 * Shots are written where `shoot-app.mjs` writes its own, so the two sets sit
 * together for whoever is reading them.
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const APP = process.env.APP ?? "http://localhost:5293";
const HERE = process.env.HERE ?? "http://127.0.0.1:14911";
const TOKEN = process.env.TOKEN ?? "";
const OUT = process.env.OUT ?? new URL("../../.firetower/shots/connectors", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

if (!TOKEN) {
  console.error("TOKEN is the demo's own: TOKEN=$(cat /tmp/ftdemo/token)");
  process.exit(1);
}

const REGISTRY = JSON.stringify([
  { url: HERE, serverId: "demo", org: "Westlabs", user: "admin", token: TOKEN, addedAt: "2026-11-12T09:00:00Z" },
]);

const browser = await chromium.launch({ channel: "chrome" });

/** A page signed in to the real demo server, in one theme. */
async function fresh(theme = "dark") {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => console.log("    pageerror:", String(e).slice(0, 200)));
  await page.addInitScript(
    ([registry, choice]) => {
      window.localStorage.setItem("firetower.servers", registry);
      window.localStorage.setItem("firetower.current", "demo");
      window.localStorage.setItem("firetower.theme", choice);
    },
    [REGISTRY, theme],
  );
  return page;
}

const at = (page, path, wait = 1400) =>
  page.goto(`${APP}/#${path}`, { waitUntil: "networkidle" }).then(() => page.waitForTimeout(wait));

async function shoot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  ${name}.png`);
}

/** Which connector row is which, by the name the demo gave it. */
async function openRow(page, name) {
  await page.locator("button.sk", { hasText: name }).first().click();
  await page.waitForTimeout(1200);
}

console.log("the library");
{
  for (const theme of ["dark", "light"]) {
    const page = await fresh(theme);
    await at(page, "/configuration/connectors");
    await shoot(page, `library-${theme}`);
    await page.close();
  }
}

console.log("adding one by URL — two fields, and the trust warning");
{
  const page = await fresh();
  await at(page, "/configuration/connectors");
  await page.getByRole("button", { name: /Add a connector/ }).first().click();
  await page.waitForTimeout(600);
  await page.getByLabel("Name").fill("westlabs-internal");
  await page.getByLabel("MCP server URL").fill("https://mcp.westlabs.dev/mcp");
  await page.getByLabel("What it is").fill("Deploy status, feature flags and the on-call rota.");
  await page.waitForTimeout(300);
  await shoot(page, "add-by-url");

  // And the failure, which is criterion 7 on screen rather than in a log.
  await page.getByLabel("MCP server URL").fill("https://mcp.example.com/mcp?api_key=sk-live-abc");
  await page.getByRole("button", { name: /Add connector/ }).first().click();
  await page.waitForTimeout(2500);
  await shoot(page, "add-refused");
  await page.close();
}

console.log("one connector · it lists its tools to a stranger (Google Drive)");
{
  const page = await fresh();
  await at(page, "/configuration/connectors");
  await openRow(page, "Google Drive");
  await shoot(page, "detail-tools");
  await page.close();
}

console.log("one connector · it lists its permissions instead (Canva)");
{
  const page = await fresh();
  await at(page, "/configuration/connectors");
  await openRow(page, "Canva");
  await shoot(page, "detail-scopes");

  // The scopes sheet: read live, two steps, the browser on the second.
  await page.getByRole("button", { name: /Sign in to Canva/ }).first().click();
  await page.waitForTimeout(3500);
  await shoot(page, "signin-scopes");
  await page.close();
}

console.log("one connector · signed in, with its tools and its drift");
{
  const page = await fresh();
  await at(page, "/configuration/connectors");
  await openRow(page, "westlabs-internal");
  await shoot(page, "detail-signed-in");
  await page.close();
}

await browser.close();
console.log(`\n  ${OUT}`);
