/**
 * The profile editor's form foot, in each of the three severities it claims.
 *
 *   node scripts/mock-server.mjs 4478 &   pnpm dev --port 5298 &
 *   HERE=http://localhost:4478 APP=http://localhost:5298 node scripts/shoot-formfoot.mjs
 *
 * `Roles.tsx` picks one of three classes onto that line — `msg`, `msg warn`,
 * `msg bad` — and for the whole life of the screen only the first of them was
 * ever defined, so a refusal and a standing note shipped in the same grey.
 * This is the second time this has happened on this screen (`STYLE.md:12`) and
 * neither instance was visible to `just check-style`, because a class a
 * component emits that no sheet defines is not drift between two sheets.
 *
 * So the evidence here is a **resolved colour**, not a photograph. A
 * screenshot of this bug and a screenshot of the fix differ by one word's
 * worth of hue, and the whole failure mode is that nobody saw it: three states
 * reading three different values out of the running document is the assertion
 * a person cannot forget to make. The pictures are for the pull request.
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { attach, fresh } from "./states.mjs";

const OUT = process.env.OUT ?? new URL("../../.firetower/shots/formfoot", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });
attach(browser);

let failed = 0;
const ok = (what, cond, saw) => {
  console.log(`  ${cond ? "✓" : "✗"} ${what}${cond ? "" : `  — saw ${saw}`}`);
  if (!cond) failed++;
};

/** Open the editor on a new profile. Same route in as `shoot-profile-skills`. */
async function editor(theme) {
  const page = await fresh(theme);
  await page.goto(`${process.env.APP ?? "http://localhost:5273"}/#/configuration/roles`, {
    waitUntil: "networkidle",
  });
  await page.waitForTimeout(900);
  await page.getByRole("button", { name: /New profile/ }).first().click();
  await page.waitForTimeout(600);
  await page.locator("button.mi").filter({ hasText: "Write it myself" }).first().click();
  await page.waitForTimeout(900);
  return page;
}

const toggle = async (page, label) => {
  const t = page.locator(`[aria-label="${label}"]`).first();
  await t.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await t.click();
  await page.waitForTimeout(250);
};

/** Tick one skill in the picker and keep it. */
async function name(page, skill) {
  await page.getByRole("button", { name: /Name a skill/ }).click();
  await page.waitForTimeout(400);
  await page.locator(".sheet2 .sh-row").filter({ hasText: skill }).first().click();
  await page.getByRole("button", { name: /^Keep these/ }).click();
  await page.waitForTimeout(400);
}

/** `rgb(…)` of a token, as this document resolves it. */
const token = (page, name) =>
  page.evaluate((n) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${n})`;
    document.body.appendChild(probe);
    const seen = getComputedStyle(probe).color;
    probe.remove();
    return seen;
  }, name);

/** What the foot says, what class it carries, and what colour it came out. */
async function foot(page) {
  const el = page.locator(".formfoot .msg").first();
  return {
    text: (await el.innerText()).trim(),
    cls: (await el.getAttribute("class")).trim(),
    colour: await el.evaluate((n) => getComputedStyle(n).color),
  };
}

const shot = async (page, id) => {
  await page.locator(".formfoot").first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await page.locator(".formfoot").first().screenshot({ path: `${OUT}/${id}.png` });
};

/* The three states, per theme. Each is driven rather than stubbed, because
   which class the component chooses is as much in question as what the class
   is worth — and the mock's 900-token skills against a 2,000 budget make both
   over-budget states reachable by clicking, which is how this was found. */
for (const theme of ["dark", "light"]) {
  console.log(`\n  ${theme}`);
  const page = await editor(theme);
  const dim = await token(page, "--color-dim");
  const brick = await token(page, "--color-brick");
  const amber = await token(page, "--color-amber");

  /* ── the refusal ───────────────────────────────────────────────────────
     Always-on plus the named list alone past the agent's cliff: broken under
     every checkout, so Save refuses. This is the one sentence on the screen
     that is a *no*, and it is what the import review screen (#357) needs the
     foot to be able to say. */
  await name(page, "pr-screenshots");
  const bad = await foot(page);
  ok("refusal · the component asks for `bad`", /\bbad\b/.test(bad.cls), bad.cls);
  ok("refusal · and says so", /Over .+'s limit/.test(bad.text), bad.text);
  ok(`refusal · is brick, not dim (${brick})`, bad.colour === brick, bad.colour);
  await shot(page, `${theme}-refusal`);

  /* ── the warning ───────────────────────────────────────────────────────
     Both sources off and nothing named: a child that cannot even publish an
     artifact. Allowed — it is a decision, not a fault — and amber is exactly
     "approaching, not broken". */
  await page.locator(".src-row .pk").first().click(); // drop pr-screenshots
  await page.waitForTimeout(250);
  await toggle(page, "Include always-on skills");
  await toggle(page, "Include the repository's defaults");
  const warn = await foot(page);
  ok("warning · the component asks for `warn`", /\bwarn\b/.test(warn.cls), warn.cls);
  ok("warning · and says so", /no Firetower skills at all/.test(warn.text), warn.text);
  ok(`warning · is amber, not dim (${amber})`, warn.colour === amber, warn.colour);
  await shot(page, `${theme}-warning`);

  /* ── the standing note ─────────────────────────────────────────────────
     One skill named, nothing over, nothing missing. The foot is back to being
     furniture and must stay the faintest tier — a neutral note that took a
     colour would be the same bug pointing the other way. */
  await name(page, "claude-api");
  const note = await foot(page);
  ok("note · no severity asked for", note.cls.trim() === "msg", note.cls);
  ok("note · and it is the standing note", /Nothing is created/.test(note.text), note.text);
  ok(`note · stays dim (${dim})`, note.colour === dim, note.colour);
  await shot(page, `${theme}-note`);

  /* The failure this whole change is about: three severities, one colour. */
  ok(
    "three severities are three colours",
    new Set([bad.colour, warn.colour, note.colour]).size === 3,
    [bad.colour, warn.colour, note.colour].join(" · "),
  );
  await page.close();
}

await browser.close();
console.log(failed ? `\n  ${failed} assertion(s) failed\n` : "\n  all assertions held\n");
process.exit(failed ? 1 : 0);
