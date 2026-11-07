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
 * | `opened-in-place` | the address did not move and the screen did: a popover, a disclosure, a tab inside the workspace |
 * | `it-threw` | it arrived, and the screen there died |
 * | `inert` | nothing happened at all |
 * | `by-design` | a tab, a filter, a switch. Marked, not counted. |
 *
 * **The middle rows are the point.** The first run reported twenty-six
 * controls as inert and not one of them was: the workspace's repository chip
 * opens a popover, an artifact row in the Overview opens a tab beside the
 * conversation, a Ship row expands in place. None of them navigates, and all
 * of them answer. A check that cannot tell *answered without navigating*
 * from *did nothing* is the check that let the original bug through — it
 * would have called the broken rows and the working ones the same thing.
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
      const before = await page.evaluate(() => ({
        hash: location.hash,
        /* A cheap fingerprint of what is on screen. Enough to tell "the
           screen answered" from "nothing at all happened", which is the
           distinction that matters and the one a URL cannot make. */
        shape: document.body.innerText.replace(/\s+/g, " ").length + ":" + document.querySelectorAll("*").length,
      }));
      const hit = page.locator('button, a[href], [role="button"], [role="menuitem"], [role="option"]').nth(c.nth);
      await hit.click({ timeout: 4000 });
      await page.waitForTimeout(700);
      const after = await page.evaluate(() => ({
        hash: location.hash,
        shape: document.body.innerText.replace(/\s+/g, " ").length + ":" + document.querySelectorAll("*").length,
      }));
      /* A sheet that opened carrying the name is a legitimate way to open a
         thing — not every opening is a navigation. */
      const inSheet = await page.evaluate(
        (name) =>
          [...document.querySelectorAll('[role="dialog"], .sheet2, .dlg, .veil, .pop')].some(
            (d) => d.getClientRects().length > 0 && (d.textContent || "").includes(name),
          ),
        c.entity.name,
      );
      /* **Arriving is not the same as arriving somewhere that works.** The
         team rail's child rows navigated correctly and then the workspace
         threw, so the address carried the right id and the screen was the
         error boundary. A check that stops at the URL calls that connected. */
      const threw = await page.evaluate(() =>
        [...document.querySelectorAll("h1, h2, p")].some((n) => (n.textContent || "").includes("This screen stopped")),
      );
      const outcome = threw
        ? "it-threw"
        : after.hash.includes(c.entity.id) || inSheet
          ? "connected"
          : after.hash !== before.hash
            ? "wrong-thing"
            : after.shape !== before.shape
              ? "opened-in-place"
              : "inert";
      if (outcome !== "connected") {
        findings.push({
          state: s.id,
          label: c.label,
          names: `${c.entity.kind} ${c.entity.id}`,
          outcome,
          landed: threw
            ? `${after.hash} — and threw`
            : after.hash !== before.hash
              ? after.hash
              : outcome === "opened-in-place"
                ? "(the screen changed)"
                : "(nothing moved)",
        });
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

/* `opened-in-place` is listed, not failed: it is a control that answered
   without navigating, which most of them legitimately are. `inert` and
   `wrong-thing` are the bugs. */
const real = findings.filter((f) => f.outcome === "inert" || f.outcome === "wrong-thing" || f.outcome === "it-threw");
const noted = findings.filter((f) => f.outcome === "opened-in-place");
const lines = ["# Does pressing a named thing open that thing?", "",
  `\`pnpm assert:connected\`. ${pressed} controls pressed. **${real.length} broken** — inert, or landed on the wrong thing. ${noted.length} answered without navigating, which is listed below rather than failed.`,
  "", "Generated — do not edit by hand.", ""];
const table = (rows) => {
  lines.push("| state | control | names | outcome | landed |", "| --- | --- | --- | --- | --- |");
  for (const f of rows) {
    const c = (v) => String(v).replace(/\|/g, "\\|").slice(0, 80);
    lines.push(`| ${f.state} | ${c(f.label)} | \`${f.names}\` | **${f.outcome}** | \`${c(f.landed)}\` |`);
  }
  lines.push("");
};
lines.push("## Broken", "");
if (real.length === 0) lines.push("_None._", "");
else table(real);
lines.push("## Answered without navigating", "",
  "A popover, a disclosure, a tab beside the conversation. Listed so somebody can confirm each is meant to be one.", "");
table(noted);
writeFileSync(`${OUT}/connectedness.md`, lines.join("\n"));
writeFileSync(`${OUT}/connectedness.json`, JSON.stringify(findings, null, 2));

const tally = {};
for (const f of findings) tally[f.outcome] = (tally[f.outcome] ?? 0) + 1;
tally.connected = pressed - findings.filter((f) => f.outcome !== "by-design").length;
for (const [k, n] of Object.entries(tally)) console.log(`  ${String(n).padStart(4)}  ${k}`);
console.log(`\n  → ${OUT}/connectedness.md`);
process.exit(real.length ? 1 : 0);
