/**
 * The states a screenshot cannot see.
 *
 * `shoot-app.mjs` photographs what a page looks like at rest. A pseudo-class
 * is invisible to it — nothing in a static shot tells you what `:hover` does,
 * and the rail's active destination shipped for two passes with a near-white
 * glyph on a pale grey box because of that. The cause was a specificity
 * split: `[data-theme="light"] .rbtn:hover` has three compound parts against
 * `.rbtn[aria-current="page"]`'s two, so in light the hover won the
 * *background* and the active rule kept the *colour*. Two rules each winning
 * half an argument is a state nobody designed.
 *
 * So this drives the states rather than drawing them, and asserts the
 * computed pair — which is the only form of this check that can fail.
 *
 *   pnpm mock &  pnpm dev &  pnpm check:states
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const APP = process.env.APP ?? "http://localhost:5273";
const HERE = process.env.HERE ?? "http://localhost:4401";

const REGISTRY = JSON.stringify([
  { url: HERE, serverId: "o_1", org: "Acme", user: "kevin", token: "tok", addedAt: "2026-09-21T09:00:00Z" },
]);

const SHOTS = process.env.SHOTS ?? new URL("../../.firetower/reconcile/states", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });
let failed = 0;

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/** Two colours are the same if their computed strings are. */
const sameish = (a, b) => a.replace(/\s/g, "") === b.replace(/\s/g, "");

for (const theme of ["light", "dark"]) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 824 }, deviceScaleFactor: 2 });
  await page.addInitScript(
    ([registry, choice]) => {
      window.localStorage.setItem("firetower.servers", registry);
      window.localStorage.setItem("firetower.current", "o_1");
      window.localStorage.setItem("firetower.theme", choice);
    },
    [REGISTRY, theme],
  );
  await page.goto(`${APP}/#/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);

  /* What the rail is supposed to be, read off the tokens rather than
     hardcoded — the values move and the relationship does not. */
  const tok = await page.evaluate(() => {
    const s = getComputedStyle(document.documentElement);
    const of = (n) => s.getPropertyValue(n).trim();
    return { bone: of("--color-bone"), panel: of("--color-panel"), dim: of("--color-dim"), text: of("--color-text") };
  });
  const asRgb = async (hex) =>
    page.evaluate((h) => {
      const d = document.createElement("div");
      d.style.color = h;
      document.body.append(d);
      const v = getComputedStyle(d).color;
      d.remove();
      return v;
    }, hex);

  const read = async (name) => {
    const el = page.getByRole("button", { name }).first();
    const at = async () =>
      el.evaluate((n) => {
        const s = getComputedStyle(n);
        return { color: s.color, background: s.backgroundColor };
      });
    const rest = await at();
    await el.hover();
    await page.waitForTimeout(220);
    const hovered = await at();
    /* And the crop, so the pair can be looked at as well as asserted — a
       passing assertion about two colours still says nothing about whether
       the result is any good. */
    await page.locator("nav").first().screenshot({ path: `${SHOTS}/rail-${slug(name)}-hover-${theme}.png` });
    /* Park the pointer somewhere harmless so the next read is clean. */
    await page.mouse.move(640, 760);
    await page.waitForTimeout(160);
    return { rest, hovered };
  };

  const say = (ok, what, got) => {
    if (!ok) failed++;
    console.log(`  ${ok ? "ok    " : "FAILED"} ${theme}: ${what}${ok ? "" : ` — got ${JSON.stringify(got)}`}`);
  };

  /* **The destination you are already on.** Hover must change nothing: it is
     already the loudest thing in the rail and has nothing to indicate. */
  const current = await read("Dashboard");
  const onBone = await asRgb(tok.bone);
  const onPanel = await asRgb(tok.panel);
  say(sameish(current.rest.background, onBone) && sameish(current.rest.color, onPanel),
      "the current destination rests inverted", current.rest);
  say(sameish(current.hovered.background, current.rest.background) &&
      sameish(current.hovered.color, current.rest.color),
      "hovering the current destination changes nothing", current.hovered);

  /* And a destination you are not on: the container takes the state, and the
     glyph goes from `--dim` to `--text`. Never the other way round. */
  const other = await read("Machines");
  const onDim = await asRgb(tok.dim);
  const onText = await asRgb(tok.text);
  say(sameish(other.rest.color, onDim), "another destination rests at --dim", other.rest);
  say(sameish(other.hovered.color, onText) && other.hovered.background !== other.rest.background,
      "hovering it lifts the glyph and brings a ground", other.hovered);

  await page.close();
}

/* ── Collapsed means collapsed ────────────────────────────────────────
   The panel's state was one answer per destination, so collapsing it and
   clicking another icon read a different slot — and every slot defaulted to
   open. A screenshot of either screen looks right; only the sequence is
   wrong, which is why it took somebody using the app to find it. */
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 824 }, deviceScaleFactor: 2 });
  await page.addInitScript(
    ([registry]) => {
      window.localStorage.setItem("firetower.servers", registry);
      window.localStorage.setItem("firetower.current", "o_1");
      window.localStorage.setItem("firetower.theme", "dark");
    },
    [REGISTRY],
  );
  await page.goto(`${APP}/#/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);

  const visible = async () =>
    page.evaluate(() => {
      const el = document.querySelector("[data-rail-panel]");
      return !!el && el.getClientRects().length > 0 && el.getBoundingClientRect().width > 80;
    });

  const say = (ok, what) => {
    if (!ok) failed++;
    console.log(`  ${ok ? "ok    " : "FAILED"} rail: ${what}`);
  };

  say(await visible(), "the panel is open to begin with");

  await page.getByRole("button", { name: /Hide the panel/i }).first().click();
  await page.waitForTimeout(500);
  say(!(await visible()), "the title bar's toggle collapses it");

  /* **And it survives a reload** — the part of the earlier behaviour that
     stands. `firetower.panel` is read at module load, before React renders,
     so a collapsed panel does not flash open on launch. */
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  say(!(await visible()), "it is still collapsed after a reload");

  /* **Pressing a destination navigates and nothing else.** This file has
     asserted both answers on the same day; the user settled it. A collapsed
     panel gives up seeing a destination's contents *without asking* — not
     the ability to see them, which hovering gives back. */
  await page.getByRole("button", { name: "Tasks" }).first().click();
  await page.waitForTimeout(700);
  say(!(await visible()), "pressing a destination leaves it collapsed");

  await page.getByRole("button", { name: /Show the panel/i }).first().click();
  await page.waitForTimeout(500);
  say(await visible(), "and the toggle still opens it");

  await page.close();
}

/* ── Hovering a destination ───────────────────────────────────────────
   Three cases, and a preview is wanted unless the thing it would preview is
   already on screen:

     active + open       → no preview, it is right there
     active + collapsed  → preview
     not active          → preview, either way

   It was "anything but the one you are on", which made the active
   destination the one place a collapsed panel could never be glimpsed —
   exactly where somebody with the panel shut spends most of their time.
   Specified three different ways over one day, so it is driven rather than
   reasoned about. */
for (const theme of ["light", "dark"]) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 824 }, deviceScaleFactor: 2 });
  await page.addInitScript(
    ([registry, choice]) => {
      window.localStorage.setItem("firetower.servers", registry);
      window.localStorage.setItem("firetower.current", "o_1");
      window.localStorage.setItem("firetower.theme", choice);
    },
    [REGISTRY, theme],
  );
  await page.goto(`${APP}/#/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);

  const panel = async () =>
    page.evaluate(() => {
      const el = document.querySelector("[data-rail-panel]");
      if (!el || el.getClientRects().length === 0) return "none";
      return getComputedStyle(el).position === "absolute" ? "floating" : "pinned";
    });
  const point = async (name) => {
    await page.getByRole("button", { name }).first().hover();
    await page.waitForTimeout(450);
  };
  const away = async () => {
    await page.mouse.move(900, 700);
    await page.waitForTimeout(450);
  };
  const say = (ok, what, got) => {
    if (!ok) failed++;
    console.log(`  ${ok ? "ok    " : "FAILED"} ${theme}: ${what}${ok ? "" : ` — got ${got}`}`);
  };

  /* Open: the active destination has nothing to preview. */
  await point("Dashboard");
  say((await panel()) === "pinned", "open · pointing at the active destination changes nothing", await panel());
  /* Open: another destination swaps the contents in place rather than floating. */
  await point("Tasks");
  say((await panel()) === "pinned", "open · pointing elsewhere swaps it in place", await panel());
  await away();

  /* Collapsed. */
  await page.getByRole("button", { name: /Hide the panel/i }).first().click();
  await page.waitForTimeout(450);
  say((await panel()) === "none", "collapsed · it is gone", await panel());

  await point("Dashboard");
  say((await panel()) === "floating", "collapsed · pointing at the **active** destination previews it", await panel());
  await away();
  say((await panel()) === "none", "collapsed · and leaving puts it away", await panel());

  await point("Tasks");
  say((await panel()) === "floating", "collapsed · pointing elsewhere previews it", await panel());
  await away();

  /* And pressing one navigates without re-opening. */
  await page.getByRole("button", { name: "Artifacts" }).first().click();
  await page.waitForTimeout(700);
  say((await panel()) === "none", "pressing a destination does not re-open it", await panel());


  await page.close();
}

/* ── The team rail's five marks ───────────────────────────────────────
   `BEAT_TONE` in `api/view.ts` is the one table that says what a status
   means, and this rail drew every one of them in neutral ink — so *working*,
   *handed back* and *ended* were one grey thing told apart by an 11px shape.
   These are visible in a screenshot and nobody read them, which is the same
   failure the hover had: a hundred and ninety-eight pictures is not a thing
   a person checks carefully.

   **Never hue alone**, so the shapes are asserted too: `failed` is a warning
   glyph rather than a second circle, because a brick circle two rows under
   an ember circle is one shape told apart by colour, which a dichromat
   cannot do. */
for (const [scene, want] of [
  ["team", [["asked you a question", "--color-ember", "dot"], ["working", "--color-slate", "typing"], ["handed back", "--color-sage", "svg"]]],
  ["team-failed", [["failed", "--color-brick", "svg"], ["ended", "--color-mute", "svg"]]],
]) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 824 }, deviceScaleFactor: 2 });
  await page.addInitScript(
    ([registry]) => {
      window.localStorage.setItem("firetower.servers", registry);
      window.localStorage.setItem("firetower.current", "o_1");
      window.localStorage.setItem("firetower.theme", "light");
    },
    [REGISTRY],
  );
  await page.request.post(`${HERE}/__reset?scene=${scene}`);
  await page.goto(`${APP}/#/sessions/s_1`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2200);

  for (const [note, token, shape] of want) {
    const got = await page.evaluate(
      ([note, token]) => {
        const d = document.createElement("div");
        document.body.append(d);
        d.style.color = `var(${token})`;
        const wanted = getComputedStyle(d).color;
        d.remove();
        /* The row whose mark means this, found by its accessible name —
           the second line says what the agent is *doing* now, not what its
           status is, so it is no longer the thing to match on. */
        const row = [...document.querySelectorAll(".tm")].find((r) =>
          r.querySelector(".lead > *")?.getAttribute("aria-label") === note ||
          r.querySelector(".lead > *")?.getAttribute("title") === note,
        );
        if (!row) return { missing: true };
        /* The mark leads the row now — it was in `.rt` beside the age until
           the status moved to the front and the agent's mark took its
           place. */
        const mark = row.querySelector(".lead > *");
        if (!mark) return { noMark: true };
        const s = getComputedStyle(mark);
        return {
          wanted,
          /* A glyph carries its tone in `color`; the two that are solid
             shapes carry it in `background`. */
          got: mark.classList.contains("typing")
            ? getComputedStyle(mark.querySelector("i")).backgroundColor
            : mark.classList.contains("dot")
              ? s.backgroundColor
              : s.color,
          shape: mark.classList.contains("dot") ? "dot" : mark.classList.contains("typing") ? "typing" : mark.tagName.toLowerCase(),
        };
      },
      [note, token],
    );
    if (got.missing || got.noMark) {
      failed++;
      console.log(`  FAILED team: no mark for "${note}" in the ${scene} scene`);
      continue;
    }
    const okColour = sameish(got.got, got.wanted);
    const okShape = got.shape === shape;
    if (!okColour || !okShape) failed++;
    console.log(
      `  ${okColour && okShape ? "ok    " : "FAILED"} team: "${note}" is ${token.replace("--color-", "")} as a ${shape}` +
        (okColour && okShape ? "" : ` — got ${got.got} as a ${got.shape}, wanted ${got.wanted}`),
    );
  }
  await page.close();
}

await browser.close();
if (failed) {
  console.error(`\n  ${failed} state(s) are not what the design says.`);
  process.exit(1);
}
console.log("\n  Every driven state is what the design says.");
