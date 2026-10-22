/**
 * Live Cursor smoke test against an isolated Firetower server and worker.
 *
 * Start the desktop Vite renderer and a Firetower server with a real database,
 * then set FIRETOWER_E2E_PASSWORD and run `node desktop/e2e/cursor-live.mjs`.
 * No API route is mocked. The provider sign-in itself needs browser approval.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, access } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright-core";

const server = process.env.FIRETOWER_E2E_SERVER ?? "127.0.0.1:4400";
const renderer = process.env.FIRETOWER_E2E_RENDERER ?? "http://127.0.0.1:5281";
const password = process.env.FIRETOWER_E2E_PASSWORD;
const output = process.env.FIRETOWER_E2E_OUTPUT ?? "/tmp/firetower-cursor-playwright";
if (!password) throw new Error("Set FIRETOWER_E2E_PASSWORD for the isolated server");

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const failures = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto(renderer);
  await page.getByPlaceholder("ft-e1.tail9c2b.ts.net").fill(server);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByPlaceholder("Username").fill("admin");
  await page.getByPlaceholder("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByText("Configuration", { exact: true }).click();
  await page.getByText("Agents", { exact: true }).click();
  await page.getByText("Cursor Agent", { exact: true }).click();
  if (await page.getByRole("button", { name: "Install", exact: true }).isVisible()) {
    await page.getByRole("button", { name: "Install", exact: true }).click();
  }
  await page.getByRole("button", { name: "Reinstall", exact: true }).waitFor({ timeout: 120_000 });
  if (process.env.FIRETOWER_E2E_TASKS === "1") {
    await page.getByText("2026.09.28-64d2043", { exact: false }).waitFor();
  }
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
    await page.getByText("Back", { exact: true }).click();
    const repository = process.env.FIRETOWER_E2E_REPOSITORY;
    if (!repository) throw new Error("Set FIRETOWER_E2E_REPOSITORY to a disposable local git repository");
    if (await page.getByText("firetower-cursor-pw-repo", { exact: false }).count() === 0) {
      const repositories = page.getByRole("heading", { name: "Repositories" }).locator("xpath=../..");
      await repositories.getByRole("button", { name: "Add", exact: true }).click();
      await page.getByPlaceholder("git@github.com:acme/web.git").fill(repository);
      await page.getByRole("button", { name: "Add it" }).click({ timeout: 30_000 });
    }
    await page.getByRole("button", { name: "New workspace", exact: true }).click();
    await page.getByPlaceholder("auth refactor").fill(`Cursor ACP Playwright ${Date.now()}`);
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

    if (process.env.FIRETOWER_E2E_PERMISSIONS === "1") {
      const root = process.env.FIRETOWER_E2E_WORKER_ROOT;
      if (!root) throw new Error("Set FIRETOWER_E2E_WORKER_ROOT to this isolated local worker's root");
      const session = page.url().split("/").at(-1);
      const candidates = (await readdir(path.join(root, "worktrees")))
        .filter((name) => name.endsWith(session.slice(-8)));
      assert.equal(candidates.length, 1, "find exactly this session's disposable worktree");
      const checkout = path.join(root, "worktrees", candidates[0], "firetower-cursor-pw-repo");
      const absent = async (name) => {
        try { await access(path.join(checkout, name)); return false; }
        catch (error) { if (error.code === "ENOENT") return true; throw error; }
      };
      const send = async (prompt) => {
        await page.getByPlaceholder("Say something to the agent").fill(prompt);
        await page.getByRole("button", { name: "Send", exact: true }).click();
      };
      const idle = () => page.getByRole("button", { name: "Send", exact: true }).waitFor({ timeout: 120_000 });
      assert.ok(await absent("shell-approved.txt"));
      await send('Use only the Shell tool to run: printf "SHELL APPROVED" > firetower-cursor-pw-repo/shell-approved.txt . No Edit File fallback or commits.');
      await page.getByRole("button", { name: "Allow", exact: true }).waitFor({ timeout: 120_000 });
      assert.ok(await absent("shell-approved.txt"), "no side effect before approval");
      await page.getByRole("button", { name: "Allow", exact: true }).click();
      await idle();
      assert.equal(await readFile(path.join(checkout, "shell-approved.txt"), "utf8"), "SHELL APPROVED");
      await page.screenshot({ path: `${output}/cursor-approved.png`, fullPage: true });
      await send('Use only the Shell tool to run: printf "MUST NOT EXIST" > firetower-cursor-pw-repo/shell-denied.txt . I will deny it. On denial stop, do not write this file with any fallback or retry. No commits.');
      await page.getByRole("button", { name: "Deny", exact: true }).click({ timeout: 120_000 });
      await page.getByPlaceholder("Why not? The agent reads this.").fill("Disposable denial test: stop without creating this file.");
      await page.getByRole("button", { name: "Deny", exact: true }).click();
      await idle();
      assert.ok(await absent("shell-denied.txt"), "denial must prevent the file effect");
      await page.screenshot({ path: `${output}/cursor-denied.png`, fullPage: true });
      await send('Use only Shell to run: sleep 30 . This is a disposable cancellation test. Do not change files.');
      await page.getByRole("button", { name: "Allow", exact: true }).waitFor({ timeout: 120_000 });
      await page.getByRole("button", { name: "Interrupt the agent", exact: true }).click();
      await idle();
      await page.screenshot({ path: `${output}/cursor-cancelled.png`, fullPage: true });
      console.log("PASS: live permission approval effect, denial prevents effect, and cancellation leaves Working");
    }

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
    if (process.env.FIRETOWER_E2E_TASKS === "1") {
      const send = async (prompt) => {
        await page.getByPlaceholder("Say something to the agent").fill(prompt);
        await page.getByRole("button", { name: "Send", exact: true }).click();
      };
      const idle = () => page.getByRole("button", { name: "Send", exact: true }).waitFor({ timeout: 120_000 });
      const tasks = page.getByRole("button", { name: /Task:/ });
      const before = await tasks.count();
      await send("Use one generalPurpose Task subagent to read firetower-cursor-pw-repo/README.md and return PLAYWRIGHT TASK followed by its exact line. Read only; no shell, edits or commits.");
      await page.getByText(/PLAYWRIGHT TASK[\s\S]*Playwright Cursor ACP smoke test\./).last().waitFor({ timeout: 120_000 });
      await idle();
      assert.ok(await tasks.count() > before, "a real Task must be rendered");
      await page.screenshot({ path: `${output}/cursor-task.png`, fullPage: true });
      const successful = await tasks.count();
      await send("Call exactly one Task with subagent_type explore. Do not retry with another type or use fallback tools. Return PLAYWRIGHT ERROR and the exact tool rejection.");
      await page.getByText(/PLAYWRIGHT ERROR[\s\S]*Invalid arguments:[\s\S]*Invalid enum value[\s\S]*explore/).last().waitFor({ timeout: 120_000 });
      await idle();
      assert.ok(await tasks.count() > successful, "the provider must actually attempt the rejected Task");
      await page.screenshot({ path: `${output}/cursor-error.png`, fullPage: true });
      console.log("PASS: real Task activity and rejected Task response are visible");
    }
    if (process.env.FIRETOWER_E2E_CLOSE === "1") {
      const session = page.url().split("/").at(-1);
      assert.match(session, /^s_[a-z0-9]+$/, "only this disposable test session may be stopped");
      await page.getByPlaceholder("Say something to the agent").fill("Use only Shell to run: sleep 30 . This tests closing a disposable agent while permission is pending. Do not change files.");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.getByRole("button", { name: "Allow", exact: true }).waitFor({ timeout: 120_000 });
      await promisify(execFile)("tmux", ["kill-session", "-t", `firetower-${session}`]);
      await page.getByRole("button", { name: "Start it again", exact: true }).waitFor({ timeout: 30_000 });
      await page.getByRole("button", { name: "Allow", exact: true }).waitFor({ state: "hidden" });
      await page.getByText("Working", { exact: true }).waitFor({ state: "hidden" });
      await page.reload();
      await page.getByRole("button", { name: "Start it again", exact: true }).waitFor();
      await page.getByText("Working", { exact: true }).waitFor({ state: "hidden" });
      assert.equal(await page.getByRole("button", { name: "Allow", exact: true }).count(), 0, "reload must not revive the exited agent's permission");
      await page.screenshot({ path: `${output}/cursor-closed.png`, fullPage: true });
      console.log("PASS: real agent exit clears pending permission and Working, including reload");
    }
  }
  if (process.env.FIRETOWER_E2E_FAILED_SESSION) {
    await page.goto(`${renderer}/#/sessions/${encodeURIComponent(process.env.FIRETOWER_E2E_FAILED_SESSION)}`);
    await page.getByText(/Authentication required/).last().waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Start it again", exact: true }).waitFor();
    await page.screenshot({ path: `${output}/cursor-auth-error.png`, fullPage: true });
    console.log("PASS: stored real provider authentication failure and recovery action are visible");
  }
} catch (error) {
  await page?.screenshot({ path: `${output}/cursor-failure.png`, fullPage: true });
  throw error;
} finally {
  await browser.close();
}
