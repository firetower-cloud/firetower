/**
 * Live Cursor smoke test against an isolated Firetower server and worker.
 *
 * Start the desktop Vite renderer and a Firetower server with a real database,
 * then set FIRETOWER_E2E_SERVER and FIRETOWER_E2E_PASSWORD and run
 * `node desktop/e2e/cursor-live.mjs`. No API route is mocked. The provider
 * sign-in itself needs browser approval.
 *
 * **A fresh database is the condition this is run under**, and a fresh
 * database holds a sign-in behind two gates before the app is drawn: the
 * first administrator's password is temporary, and the server is not set up
 * until an organisation is named. Both are passed on the way in — the
 * password over the API, which is the only place it can be replaced, and the
 * wizard by going through it — so FIRETOWER_E2E_PASSWORD can be the password
 * the server printed at its first start with nothing done to it by hand.
 *
 * What a fresh database cannot give back is a machine, and an agent is
 * installed on one. See `docs/acp.md`.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, access } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { origin, refusal } from "./target.mjs";

// **No default.** This run replaces an administrator's password and names an
// organisation, and the address it would have guessed — `127.0.0.1:4400` — is
// where a developer's own control plane listens. A harness that writes is told
// what to write to or it does not run, which is how the password beside it has
// always been handled.
const server = process.env.FIRETOWER_E2E_SERVER;
// `desktop/vite.config.ts` hardcodes this port with `strictPort`, so a plain
// `pnpm --dir desktop dev` is what this default expects. Still defaulted,
// because the default is this checkout's own renderer on loopback — but the
// page is handed the password through the sign-in form, so a second renderer
// is this variable as well as a port.
const renderer = process.env.FIRETOWER_E2E_RENDERER ?? "http://localhost:5273";
const password = process.env.FIRETOWER_E2E_PASSWORD;
const output = process.env.FIRETOWER_E2E_OUTPUT ?? "/tmp/firetower-cursor-playwright";
if (!server) {
  throw new Error(
    "Set FIRETOWER_E2E_SERVER to the isolated server's address — this run writes to it and will not guess",
  );
}
if (!password) throw new Error("Set FIRETOWER_E2E_PASSWORD for the isolated server");

/**
 * The control plane, and the proof that it is one this run may write to.
 *
 * `origin()` settles the scheme — the app's rule for a bare address, less the
 * silent fall back to http that would carry the password in clear — and
 * `refusal()` reads the unauthenticated `/api/v1/bootstrap` and will not go on
 * against a server somebody has already set up. Both are before the first
 * write, which is the only place they are worth anything, and both are in
 * `target.mjs` so `target.test.mjs` can hold them to it.
 */
const control = origin(server);
const found = await fetch(`${control}/api/v1/bootstrap`, { redirect: "error" }).catch((e) => {
  throw new Error(`Nothing answered as a Firetower at ${control}: ${e.message}`);
});
if (!found.ok) throw new Error(`${control} answered ${found.status} to /api/v1/bootstrap`);
const refused = refusal(await found.json().catch(() => null), control);
if (refused) throw new Error(refused);

/**
 * One call to the control plane, for what the app cannot do or cannot say.
 *
 * `redirect: "error"`, because the origin above is the one that was checked:
 * a 30x carrying this POST to somewhere else would carry the password with it
 * and arrive at a server nothing has asked anything about.
 */
const call = async (path, body, token) => {
  const answer = await fetch(`${control}${path}`, {
    method: body ? "POST" : "GET",
    redirect: "error",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const said = await answer.json().catch(() => null);
  if (!answer.ok) throw new Error(`${path} answered ${answer.status}: ${said?.message ?? "no message"}`);
  return said;
};

/**
 * **The password gate**, cleared before the window is opened.
 *
 * The first administrator's password is temporary (`must_change_password`),
 * and the app deliberately carries no form to replace it — `ReplacePassword`
 * points at a browser instead, so a sign-in that meets this stops dead. It is
 * replaced over the API, which is one of the four calls a locked account may
 * still make (`auth.rs`), with the same password: what stands in the way is
 * the flag, not the secret, and a harness that invented a second credential
 * would hand its caller back a server it can no longer sign in to.
 */
let { token, user } = await call("/api/v1/auth/login", { username: "admin", password });
if (user.mustChangePassword) {
  ({ token } = await call("/api/v1/auth/password", { current: password, new: password }, token));
  console.log("PASS: replaced the first administrator's temporary password");
}

/**
 * **The setup gate**, asked of the server rather than read off the screen.
 *
 * `Gate.tsx` draws the wizard until `/api/v1/setup` reports completed — but
 * it draws the app while its two questions are still in flight, so a wait
 * that races the screen walks straight past a gate that is about to appear.
 * The server's answer is the one that cannot be early.
 */
const outstanding = await call("/api/v1/setup", undefined, token);

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const failures = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto(renderer);
  // The settled origin rather than what was typed: `probe.ts` keeps an address
  // that carries a scheme as it is, so the window reaches the same server this
  // script checked, by the same scheme, instead of deciding again.
  await page.getByPlaceholder("ft-e1.tail9c2b.ts.net").fill(control);
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  await page.getByPlaceholder("Username").fill("admin");
  await page.getByPlaceholder("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  // The wizard, which the app itself carries, and the rail behind it.
  const naming = page.getByRole("heading", { name: "Name this Firetower" });
  const finishing = page.getByRole("button", { name: "Open Firetower", exact: true });
  const inside = page.getByRole("navigation", { name: "Destinations" });

  if (!outstanding.completed) {
    await naming.or(finishing).first().waitFor({ timeout: 30_000 });
    if (await naming.isVisible()) {
      await page.getByPlaceholder("Westlabs").fill("Cursor Playwright");
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await finishing.waitFor({ timeout: 30_000 });
    }
    await finishing.click();
    console.log("PASS: finished setting up a server nobody had set up");
  }
  await inside.waitFor({ timeout: 30_000 });

  await page.getByRole("button", { name: "Customize", exact: true }).click();
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByText("Cursor Agent", { exact: true }).click();
  const install = page.getByRole("button", { name: "Install", exact: true }).first();
  const reinstall = page.getByRole("button", { name: "Reinstall", exact: true }).first();
  // An agent is installed *on a machine*, so `config/Agents.tsx` draws one of
  // these per machine and a server with none has neither. Said plainly rather
  // than waited for: a fresh database has no machine, and a two-minute wait
  // for a control that cannot appear is the failure this script was taught to
  // avoid on the way in. The message names the way out, because a fresh
  // database is the documented condition for this run and this prerequisite
  // is the one thing dropping the database cannot give back.
  await install.or(reinstall).first().waitFor({ timeout: 30_000 }).catch(() => {
    throw new Error(
      "No machine to install the Cursor agent on, and an agent is installed on one — a fresh database has none. " +
        "Add a machine first: an Alpine sshd container is the cheapest one that is not your own laptop, and " +
        "firetower-cloud/firetower#332 has the measured recipe. See docs/acp.md.",
    );
  });
  if (await install.isVisible()) await install.click();
  await reinstall.waitFor({ timeout: 120_000 });
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
