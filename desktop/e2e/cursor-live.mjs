/**
 * Live Cursor smoke test against an isolated Firetower server and worker.
 *
 * Start the desktop Vite renderer and a Firetower server with a real database,
 * then set FIRETOWER_E2E_PASSWORD and run `node desktop/e2e/cursor-live.mjs`.
 * No API route is mocked. The provider sign-in itself needs browser approval.
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const server = process.env.FIRETOWER_E2E_SERVER ?? "127.0.0.1:4400";
const renderer = process.env.FIRETOWER_E2E_RENDERER ?? "http://127.0.0.1:5281";
const password = process.env.FIRETOWER_E2E_PASSWORD;
const output = process.env.FIRETOWER_E2E_OUTPUT ?? "/tmp/firetower-cursor-playwright";
if (!password) throw new Error("Set FIRETOWER_E2E_PASSWORD for the isolated server");

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const failures = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto(renderer);
  await page.getByPlaceholder("ft-e1.tail9c2b.ts.net").fill(server);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByPlaceholder("Username").fill("admin");
  await page.getByPlaceholder("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByText("Configuration", { exact: true }).click();
  await page.getByText("Cursor Agent", { exact: true }).click();
  if (await page.getByRole("button", { name: "Install", exact: true }).isVisible()) {
    await page.getByRole("button", { name: "Install", exact: true }).click();
  }
  await page.getByRole("button", { name: "Reinstall", exact: true }).waitFor({ timeout: 120_000 });
  await page.screenshot({ path: `${output}/cursor-installed.png`, fullPage: true });
  assert.equal(failures.length, 0, `Page errors: ${failures.join("; ")}`);
  console.log("PASS: real server login, Cursor Agent row, and install action");

  if (process.env.FIRETOWER_E2E_CONNECT === "1") {
    await page.getByRole("button", { name: "Connect an account" }).click();
    await page.getByPlaceholder("Personal Claude, Work, Client Acme…").fill("Cursor Playwright");
    await page.getByRole("button", { name: "Continue to sign in" }).click();
    const link = page.getByRole("link", { name: "Continue with Cursor" });
    await link.waitFor({ timeout: 30_000 });
    console.log(`CURSOR_APPROVAL_URL=${await link.getAttribute("href")}`);
    await page.getByText("Account connected", { exact: true }).waitFor({ timeout: 300_000 });
    await page.screenshot({ path: `${output}/cursor-connected.png`, fullPage: true });
    await page.getByRole("button", { name: "Done" }).click();
    console.log("PASS: Cursor account signed in through the live provider");
  }

  if (process.env.FIRETOWER_E2E_RUN === "1") {
    const repository = process.env.FIRETOWER_E2E_REPOSITORY;
    if (!repository) throw new Error("Set FIRETOWER_E2E_REPOSITORY to a disposable local git repository");
    if (await page.getByText("firetower-cursor-pw-repo", { exact: false }).count() === 0) {
      const repositories = page.getByRole("heading", { name: "Repositories" }).locator("xpath=../..");
      await repositories.getByRole("button", { name: "Add", exact: true }).click();
      await page.getByPlaceholder("git@github.com:acme/web.git").fill(repository);
      await page.getByRole("button", { name: "Add it" }).click({ timeout: 30_000 });
    }
    await page.getByRole("button", { name: /New workspace/ }).click();
    await page.getByPlaceholder("auth refactor").fill("Cursor ACP Playwright");
    await page.locator("button").filter({ hasText: "Choose a repository" }).click();
    await page.getByPlaceholder("Find a repository").fill("firetower-cursor-pw-repo");
    await page.getByText("firetower-cursor-pw-repo", { exact: false }).last().click();
    await page.getByRole("button", { name: /Cursor Agent/ }).last().click();
    await page.getByRole("button", { name: /Start it/ }).click({ timeout: 30_000 });
    await page.getByPlaceholder("Say something to the agent").fill("Read README.md and reply with its exact one-line content. Do not edit any files.");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByText("Playwright Cursor ACP smoke test.", { exact: false }).last().waitFor({ timeout: 120_000 });
    await page.getByText("Working", { exact: true }).waitFor({ state: "hidden", timeout: 120_000 });
    await page.screenshot({ path: `${output}/cursor-turn.png`, fullPage: true });
    assert.equal(failures.length, 0, `Page errors: ${failures.join("; ")}`);
    console.log("PASS: real Cursor ACP turn through the Desktop renderer");

    if (process.env.FIRETOWER_E2E_FOLLOWUP === "1") {
      const answer = page.getByText("Playwright Cursor ACP smoke test.", { exact: false });
      const before = await answer.count();
      await page.getByPlaceholder("Say something to the agent").fill("What was the exact README line you just returned? Reply with that line only.");
      await page.getByRole("button", { name: "Send" }).click();
      await answer.nth(before).waitFor({ timeout: 120_000 });
      await page.getByText("Working", { exact: true }).waitFor({ state: "hidden", timeout: 120_000 });
      const after = await answer.count();
      assert.ok(after > before, "the follow-up must recall the file line");
      await page.reload();
      await answer.last().waitFor({ timeout: 30_000 });
      assert.equal(await answer.count(), after, "reconnect must not duplicate the recalled answer");
      await page.screenshot({ path: `${output}/cursor-followup.png`, fullPage: true });
      console.log("PASS: follow-up memory and page reconnect without duplicate answer");
    }
  }
} finally {
  await browser.close();
}
