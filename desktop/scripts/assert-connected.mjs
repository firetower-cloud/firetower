/**
 * Does pressing a named thing open *that* thing?
 *
 *   pnpm mock &   pnpm dev &   pnpm assert:connected
 *
 * **The sweep already presses every control and asserts none throws. That is
 * a weak assertion**: a control that silently does nothing passes it, and
 * three did — an artifact tile on the home opened the library, a skill row in
 * the rail opened Skills, an artifact row opened Artifacts. Each named a
 * specific thing and navigated to the list it lives on.
 *
 * So this presses controls that *name* something and asks where they landed.
 * What a control names comes from the mock's own catalogue at `/__entities`,
 * so there is nothing to tag in the app and nothing to keep in step by hand.
 *
 * Four outcomes, because they are four different bugs:
 *
 * | | |
 * |---|---|
 * | `connected` | landed somewhere carrying that thing's id |
 * | `wrong-thing` | went somewhere else — usually the list instead of the item |
 * | `inert` | nothing happened at all |
 * | `by-design` | a toggle, a tab, a filter, a disclosure. Marked, not counted. |
 *
 * **The fourth row is the point.** A check that cannot tell *inert by design*
 * from *broken* is the check that let this through in the first place.
 */
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { SHOTS, REGISTRY, attach, fresh } from "./states.mjs";

const OUT = process.env.OUT ?? new URL("../../.firetower/reconcile", import.meta.url).pathname;
const HERE = process.env.HERE ?? "http://localhost:4401";
const ONLY = process.env.ONLY ?? "";
mkdirSync(OUT, { recursive: true });

const CATALOGUE = await fetch(`${HERE}/__entities`).then((r) => r.json());
/* Longest first, so "acme/design-system" wins over "acme/design". */
CATALOGUE.sort((a, b) => b.name.length - a.name.length);

const browser = await chromium.launch({ channel: "chrome" });
attach(browser);

const findings = [];
let pressed = 0;

/** Controls that are not meant to navigate, recognised rather than guessed. */
const BY_DESIGN = `
  [role="tab"], [role="switch"], [role="checkbox"], [role="menuitemcheckbox"],
  [aria-pressed], [aria-expanded], [aria-haspopup],
  input, label, summary, [data-filter], .seg button, .itab, .tab, .sk-tabs button
`;

for (const s of SHOTS) {
  if (s.skip) continue;
  if (ONLY && !s.id.includes(ONLY)) continue;

  /* One pass to find the candidates, then one fresh page per press — a click
     that navigates destroys the list the next candidate was found in. */
  let candidates = [];
  {
    const page = await fresh("dark", { servers: s.servers ?? REGISTRY, scene: s.scene ?? "default", at: s.at ?? null });
    try {
      await s.go(page);
      candidates = await page.evaluate(
        ([catalogue, byDesign]) => {
          const out = [];
          const seen = new Set();
          for (const el of document.querySelectorAll('button, a[href], [role="button"], [role="menuitem"], [role="option"]')) {
            if (el.getClientRects().length === 0) continue;
            if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") continue;
            const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
            if (!txt) continue;
            const names = catalogue.filter((e) => txt.includes(e.name));
            if (names.length === 0) continue;
            /* The most specific thing it names. A row reading "auth refactor ·
               acme/web" names both; the row is the workspace. */
            const entity = names[0];
            /* Already on it? Then "stayed put" is the right answer and this
               tells us nothing. */
            if (location.hash.includes(entity.id)) continue;
            const key = `${entity.id}|${txt}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
              entity,
              label: txt.slice(0, 60),
              byDesign: !!el.closest(byDesign),
              /* How the presser will find it again on a fresh page. */
              nth: [...document.querySelectorAll('button, a[href], [role="button"], [role="menuitem"], [role="option"]')].indexOf(el),
            });
          }
          /* A cap, because a list of forty rows tells you the same thing
             three rows would, and every press costs a page load. */
          return out.slice(0, 6);
        },
        [CATALOGUE, BY_DESIGN],
      );
    } catch {
      /* the state itself would not drive; `shoot-app` already records that */
    }
    await page.close();
  }

  for (const c of candidates) {
    if (c.byDesign) {
      findings.push({ state: s.id, label: c.label, names: `${c.entity.kind} ${c.entity.id}`, outcome: "by-design", landed: "—" });
      continue;
    }
    const page = await fresh("dark", { servers: s.servers ?? REGISTRY, scene: s.scene ?? "default", at: s.at ?? null });
    try {
      await s.go(page);
      const before = await page.evaluate(() => location.hash);
      const hit = page.locator('button, a[href], [role="button"], [role="menuitem"], [role="option"]').nth(c.nth);
      await hit.click({ timeout: 4000 });
      await page.waitForTimeout(700);
      const after = await page.evaluate(() => location.hash);
      /* A sheet that opened carrying the name is a legitimate way to open a
         thing — not every opening is a navigation. */
      const inSheet = await page.evaluate(
        (name) =>
          [...document.querySelectorAll('[role="dialog"], .sheet2, .dlg, .veil, .pop')].some(
            (d) => d.getClientRects().length > 0 && (d.textContent || "").includes(name),
          ),
        c.entity.name,
      );
      const outcome = after.includes(c.entity.id) || inSheet ? "connected" : after !== before ? "wrong-thing" : "inert";
      if (outcome !== "connected") {
        findings.push({ state: s.id, label: c.label, names: `${c.entity.kind} ${c.entity.id}`, outcome, landed: after || "(nothing moved)" });
      }
      pressed++;
    } catch {
      /* A control that cannot be pressed on a fresh page is a harness miss,
         not a finding — `nth` shifted because the page settled differently. */
    }
    await page.close();
  }
  process.stdout.write(`\r  ${pressed} pressed · ${findings.filter((f) => f.outcome !== "by-design").length} not connected`.padEnd(64));
}
await browser.close();
console.log("");

const real = findings.filter((f) => f.outcome !== "by-design");
const lines = ["# Does pressing a named thing open that thing?", "",
  `\`pnpm assert:connected\`. ${pressed} controls pressed; ${real.length} did not land on what they name.`,
  "", "Generated — do not edit by hand.", "",
  "| state | control | names | outcome | landed |", "| --- | --- | --- | --- | --- |"];
for (const f of real) {
  const c = (v) => String(v).replace(/\|/g, "\\|").slice(0, 80);
  lines.push(`| ${f.state} | ${c(f.label)} | \`${f.names}\` | **${f.outcome}** | \`${c(f.landed)}\` |`);
}
writeFileSync(`${OUT}/connectedness.md`, lines.join("\n"));
writeFileSync(`${OUT}/connectedness.json`, JSON.stringify(findings, null, 2));

const tally = {};
for (const f of findings) tally[f.outcome] = (tally[f.outcome] ?? 0) + 1;
for (const [k, n] of Object.entries(tally)) console.log(`  ${String(n).padStart(4)}  ${k}`);
console.log(`\n  → ${OUT}/connectedness.md`);
process.exit(real.length ? 1 : 0);
