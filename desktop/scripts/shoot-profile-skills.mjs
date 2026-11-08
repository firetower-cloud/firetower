/**
 * The profile editor's Skills section, driven and photographed.
 *
 *   node scripts/mock-server.mjs 4471 &   pnpm dev --port 5293 &
 *   HERE=http://localhost:4471 APP=http://localhost:5293 node scripts/shoot-profile-skills.mjs
 *
 * One shot per state the `profile-skills` prototype drew, plus the assertions
 * the acceptance criteria name — so the numbered list is checked against the
 * build rather than against a reading of it. The breakdown summing to the
 * figure is the one worth driving: it is arithmetic over four lists and a
 * de-duplication, and it is the promise the section makes.
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { attach, fresh } from "./states.mjs";

const OUT = process.env.OUT ?? new URL("../../.firetower/shots/profile-skills", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });
attach(browser);

let failed = 0;
const ok = (what, cond, saw) => {
  console.log(`  ${cond ? "✓" : "✗"} ${what}${cond ? "" : `  — saw ${saw}`}`);
  if (!cond) failed++;
};

/** Open the editor on a new profile, with the Skills section in view. */
async function editor(theme = "dark") {
  const page = await fresh(theme);
  await page.goto(`${process.env.APP ?? "http://localhost:5293"}/#/configuration/roles`, {
    waitUntil: "networkidle",
  });
  await page.waitForTimeout(900);
  await page.getByRole("button", { name: /New profile/ }).first().click();
  await page.waitForTimeout(600);
  await page.locator("button.mi").filter({ hasText: "Write it myself" }).first().click();
  await page.waitForTimeout(900);
  return page;
}

/** The figure, the breakdown's numbers, and the count on each source row. */
async function read(page) {
  const fig = (await page.locator(".answer .fig").innerText()).trim();
  const lines = await page.locator(".answer .brk .ln").all();
  const brk = [];
  for (const ln of lines)
    brk.push({
      n: Number((await ln.locator(".n").innerText()).trim()),
      src: (await ln.locator(".src").innerText()).trim(),
      off: (await ln.getAttribute("class")).includes("off"),
    });
  const count = Number(/It loads (\d+)/.exec(fig)?.[1] ?? 0);
  return { fig, brk, count, sum: brk.reduce((a, l) => a + l.n, 0) };
}

const shot = async (page, id) => {
  await page.locator(".srcs").scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/${id}.png`, fullPage: true });
};

/* ── 1: a new profile, both switches on, nothing named ─────────────── */
{
  const page = await editor();
  const togs = await page.locator(".src-row .tog").all();
  ok("1 · two inheritance switches", togs.length === 2, `${togs.length}`);
  const checked = await Promise.all(togs.map((t) => t.getAttribute("aria-checked")));
  ok("1 · both on", checked.every((c) => c === "true"), checked.join(","));
  ok(
    "1 · an empty always-include list",
    (await page.locator(".src-row .pickrow .pk").count()) === 1,
    `${await page.locator(".src-row .pickrow .pk").count()} pills`,
  );
  ok(
    "1 · All / Only these is gone from Skills",
    (await page.locator('[aria-label="Which of these it may reach"]').count()) === 0,
    "still there",
  );

  const a = await read(page);
  ok(`2 · the breakdown sums to the figure (${a.count})`, a.sum === a.count, `${a.sum}`);
  await shot(page, "new-profile");

  /* ── 3: always-on off removes exactly those ───────────────────────── */
  const alwaysWas = a.brk[0].n;
  await page.locator('[aria-label="Include always-on skills"]').click();
  await page.waitForTimeout(250);
  const b = await read(page);
  ok(
    `3 · always-on off removes exactly those (${alwaysWas})`,
    b.count === a.count - alwaysWas && b.brk[0].off && b.brk[0].n === 0,
    `${a.count} → ${b.count}`,
  );
  ok("3 · and still sums", b.sum === b.count, `${b.sum} vs ${b.count}`);
  ok(
    "12 · the host-directory qualifier appears on Claude Code",
    (await page.locator(".src-row .review").count()) === 1,
    "absent",
  );

  /* ── 4: repository defaults off removes exactly those ─────────────── */
  await page.locator('[aria-label="Include always-on skills"]').click();
  await page.waitForTimeout(200);
  const repoWas = (await read(page)).brk[1].n;
  await page.locator('[aria-label="Include the repository\'s defaults"]').click();
  await page.waitForTimeout(250);
  const c = await read(page);
  ok(
    `4 · repository defaults off removes exactly those (${repoWas})`,
    c.count === a.count - repoWas && c.brk[1].off,
    `${a.count} → ${c.count}`,
  );
  await page.locator('[aria-label="Include the repository\'s defaults"]').click();
  await page.waitForTimeout(200);

  /* ── 13: all four risk categories on a row, and 5: de-duplication ── */
  await page.getByRole("button", { name: /Name a skill/ }).click();
  await page.waitForTimeout(400);
  ok(
    "13 · risk marks are drawn on skill rows",
    (await page.locator(".sheet2 .sh-row .risk").count()) > 0,
    "none",
  );
  const kinds = new Set(
    (await page.locator(".sheet2 .sh-row .risks .risk").allInnerTexts()).map((t) => t.trim()),
  );
  console.log(`      risk phrases drawn: ${[...kinds].join(" · ")}`);
  await page.screenshot({ path: `${OUT}/picker.png` });

  // Tick one the always-on switch already supplies: the count must not move.
  const already = page.locator(".sheet2 .sh-row").filter({ hasText: "firetower-surfaces" }).first();
  await already.click();
  await page.waitForTimeout(150);
  ok(
    "5 · the sheet says a supplied skill is already included",
    (await already.locator(".already").count()) === 1,
    "no note",
  );
  await page.getByRole("button", { name: /^Keep these/ }).click();
  await page.waitForTimeout(350);
  const d = await read(page);
  ok(`5 · naming a supplied skill adds zero`, d.count === a.count, `${a.count} → ${d.count}`);
  ok("5 · and the lines still sum", d.sum === d.count, `${d.sum} vs ${d.count}`);
  ok(
    "5 · the breakdown says it was already included",
    d.brk[2].src.includes("already included"),
    d.brk[2].src,
  );
  await shot(page, "named-already-supplied");

  /* ── 10: both off and empty says so before it is saved ────────────── */
  await page.locator(".src-row .pk").first().click(); // drop the one named
  await page.waitForTimeout(200);
  await page.locator('[aria-label="Include always-on skills"]').click();
  await page.locator('[aria-label="Include the repository\'s defaults"]').click();
  await page.waitForTimeout(300);
  const bare = await read(page);
  ok("10 · zero skills", bare.count === 0 && /loads no skills/.test(bare.fig), bare.fig);
  const foot = (await page.locator(".formfoot .msg").innerText()).trim();
  ok("10 · the foot says so before saving", /no Firetower skills at all/.test(foot), foot);
  const save = (await page.locator(".formfoot .btn.primary").innerText()).trim();
  ok("10 · and the button names it", /no skills/.test(save), save);
  ok(
    "10 · the host note says it is not hermetic",
    /not hermetic/.test(await page.locator(".host").innerText()),
    "absent",
  );
  await shot(page, "both-off-empty");
  await page.close();
}

/* ── 12: the qualifier is agent-dependent ─────────────────────────────── */
{
  const page = await editor();
  await page.locator('[aria-label="Include always-on skills"]').click();
  await page.waitForTimeout(250);
  for (const [label, reads] of [
    ["Codex", false],
    ["Kimi Code", false],
    ["Cursor Agent", false],
    ["Claude Code", true],
  ]) {
    /* Settle the scroll before pressing: `Pop` closes on any ancestor
       scrolling — deliberately, so a menu never floats away from its button —
       and Playwright's own scroll-into-view fires one. */
    const agent = page.locator('button[aria-haspopup="listbox"][aria-label="Agent"]').first();
    await agent.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await agent.click();
    await page.waitForTimeout(400);
    await page.locator('[role="option"]').filter({ hasText: label }).first().click();
    await page.waitForTimeout(400);
    const plain = (await page.locator(".src-row .review").count()) > 0;
    const slate = (await page.locator(".src-row .review.slate").count()) > 0;
    ok(
      `12 · ${label}: ${reads ? "the host qualifier" : "the reassurance"}`,
      reads ? plain && !slate : slate,
      `review=${plain} slate=${slate}`,
    );
    if (label === "Codex") await shot(page, "always-off-codex");
  }
  // An unpinned profile is the Claude Code case too: the lead may be running it.
  await shot(page, "always-off-claude");
  await page.close();
}

/* ── the light branch, because light is the design ───────────────────── */
{
  const page = await editor("light");
  await shot(page, "new-profile-light");
  await page.close();
}

await browser.close();
console.log(failed ? `\n  ${failed} assertion(s) failed\n` : "\n  all assertions held\n");
process.exit(failed ? 1 : 0);
