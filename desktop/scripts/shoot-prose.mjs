/**
 * The conversation's markdown, photographed and measured.
 *
 *   pnpm dev --port 5377 &
 *   APP=http://localhost:5377 OUT=../.firetower/shots/prose node scripts/shoot-prose.mjs
 *
 * It drives `/prose.html`, the dev harness, because every question #FT-B
 * raises is a *layout* one — how wide a column came out, where a line broke,
 * whether anything scrolls — and jsdom has no table layout algorithm to ask.
 * A unit test can hold the rule in `styles.css`; only a browser can hold what
 * the rule does.
 *
 * **Line boxes against words, not pixels.** A cell of N words, broken only at
 * its spaces, occupies at most N lines. More than that and something broke
 * mid-word, which is the whole of the bug: `overflow-wrap: anywhere` was
 * inherited into every cell, and `anywhere` is the one value that also counts
 * its break points when *min-content* is measured — so each column's minimum
 * was about one character, and the auto table algorithm spent the width on
 * the columns holding sentences. "Engineering Manager" came out as
 * `Enginee / ring / Manager`. Counting line boxes says that in the one way no
 * font metric can argue with.
 *
 * The rest are the protections the fix may not spend: a long URL in a
 * paragraph still wraps rather than widening the pane, a table with more
 * columns than the pane still wraps rather than scrolling, and a table that
 * genuinely cannot be made to fit — a cell holding a 64-character hash —
 * scrolls inside its own wrapper rather than pushing the conversation
 * sideways.
 *
 * One specimen per page, addressed by `?only=`, so a picture is of the same
 * pixels whatever the specimens above it did: this is run twice, against the
 * branch and against `main`, and the pair is the evidence.
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const APP = process.env.APP ?? "http://localhost:5377";
const OUT = process.env.OUT ?? new URL("../../.firetower/shots/prose", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });

let failed = 0;
const ok = (what, cond, saw) => {
  console.log(`  ${cond ? "✓" : "✗"} ${what}${cond ? "" : `  — saw ${saw}`}`);
  if (!cond) failed++;
};

/** The window at its two widths. 880 is `tauri.conf.json`'s `minWidth`. */
const WIDTHS = { desk: 1280, narrow: 880 };

async function open(theme, only, { width = "desk", pane } = {}) {
  const page = await browser.newPage({
    viewport: { width: WIDTHS[width], height: 900 },
    deviceScaleFactor: 2,
  });
  page.on("pageerror", (e) => console.log("    pageerror:", String(e).slice(0, 200)));
  await page.addInitScript((t) => window.localStorage.setItem("firetower.theme", t), theme);
  await page.goto(`${APP}/prose.html?only=${only}${pane ? `&pane=${pane}` : ""}`, {
    waitUntil: "networkidle",
  });
  await page.waitForTimeout(350);
  return page;
}

const shot = (page, id, name) => page.locator(`[data-shot="${id}"]`).screenshot({ path: `${OUT}/${name}.png` });

/**
 * How many line boxes each cell of a row came out on, beside how many words
 * it holds. Measured off `Range` rects rather than off the height of the
 * cell: padding and line-height would both have to be guessed at, and a rect
 * per line box is the thing itself.
 */
const cells = (page, selector) =>
  page.evaluate((sel) =>
    [...document.querySelectorAll(sel)].map((cell) => {
      const tops = new Set();
      const walk = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) if (r.width > 0) tops.add(Math.round(r.top));
      }
      const text = cell.textContent.trim();
      return {
        text,
        words: text.split(/\s+/).filter(Boolean).length,
        lines: tops.size,
        width: Math.round(cell.getBoundingClientRect().width),
      };
    }), selector);

/** What the table's wrapper is doing, and whether the pane paid for it. */
const scrollOf = (page, id) =>
  page.evaluate((shotId) => {
    const wrap = document.querySelector(`[data-shot="${shotId}"] table`).parentElement;
    return {
      overflow: getComputedStyle(wrap).overflowX,
      inside: wrap.scrollWidth - wrap.clientWidth,
      doc: document.documentElement.scrollWidth,
      seen: window.innerWidth,
    };
  }, id);

/** Nothing is lost off the right-hand end: scroll there and look. */
const far = (page, id) =>
  page.evaluate((shotId) => {
    const wrap = document.querySelector(`[data-shot="${shotId}"] table`).parentElement;
    wrap.scrollLeft = wrap.scrollWidth;
    const last = wrap.querySelector("thead tr").lastElementChild;
    const box = wrap.getBoundingClientRect();
    const edge = last.getBoundingClientRect();
    return { label: last.textContent, inside: edge.right <= box.right + 1 && edge.left >= box.left - 1 };
  }, id);

for (const theme of ["dark", "light"]) {
  console.log(`\n  ── ${theme} ──`);

  /* ── The reported case: short labels, long prose beside them ────────── */
  for (const [width, pane] of [["desk", undefined], ["narrow", 560]]) {
    const page = await open(theme, "roles", { width, pane });
    await shot(page, "roles", `roles-${width}-${theme}`);
    const first = await cells(page, '[data-shot="roles"] tbody tr > *:first-child');
    for (const cell of first) {
      ok(
        `roles · ${width} · "${cell.text}" breaks only at its spaces (${cell.lines}/${cell.words} lines, ${cell.width}px)`,
        cell.lines <= cell.words,
        `${cell.lines} lines for ${cell.words} words`,
      );
    }
    const over = await scrollOf(page, "roles");
    ok(`roles · ${width} · the pane is not pushed wider`, over.doc <= over.seen, `${over.doc} > ${over.seen}`);
    ok(`roles · ${width} · and the table needs no scroll to be read`, over.inside === 0, `${over.inside}px`);
    await page.close();
  }

  /* ── The protection the fix must not spend ──────────────────────────── */
  {
    const page = await open(theme, "url");
    await shot(page, "url", `url-desk-${theme}`);
    const p = await page.evaluate(() => {
      const el = document.querySelector('[data-shot="url"] p');
      const tops = new Set();
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) if (r.width > 0) tops.add(Math.round(r.top));
      }
      return {
        lines: tops.size,
        over: el.scrollWidth - el.clientWidth,
        doc: document.documentElement.scrollWidth,
        seen: window.innerWidth,
      };
    });
    ok(`url · a URL and a hash wrap rather than running on (${p.lines} lines)`, p.lines > 1, `${p.lines}`);
    ok(`url · and do not overflow the paragraph`, p.over <= 1, `${p.over}px`);
    ok(`url · nor widen the pane`, p.doc <= p.seen, `${p.doc} > ${p.seen}`);
    await page.close();
  }

  /* ── More columns than the pane has room for ─────────────────────────
     Breakable content, so the answer is a narrower column rather than a
     scroll — and still no word broken inside itself. */
  for (const [width, pane] of [["desk", undefined], ["narrow", 560]]) {
    const page = await open(theme, "wide", { width, pane });
    await shot(page, "wide", `wide-${width}-${theme}`);
    const head = await cells(page, '[data-shot="wide"] thead th');
    const broken = head.filter((c) => c.lines > c.words);
    ok(
      `wide · ${width} · all ${head.length} headers break only at their spaces`,
      broken.length === 0,
      broken.map((c) => `${c.text} (${c.lines}/${c.words})`).join(", "),
    );
    const over = await scrollOf(page, "wide");
    ok(`wide · ${width} · the conversation does not scroll sideways`, over.doc <= over.seen, `${over.doc} > ${over.seen}`);
    await page.close();
  }

  /* ── And one that cannot be made to fit ──────────────────────────────
     A 64-character hash has nowhere to break, so the column is as wide as
     the hash whatever the pane says. The wrapper is where that is paid for. */
  {
    const page = await open(theme, "unbreakable");
    await shot(page, "unbreakable", `unbreakable-desk-${theme}`);
    const over = await scrollOf(page, "unbreakable");
    ok(`unbreakable · the wrapper is the scroller (${over.overflow})`, over.overflow === "auto", over.overflow);
    ok(`unbreakable · and it has something to scroll (${over.inside}px)`, over.inside > 0, `${over.inside}px`);
    ok(`unbreakable · the conversation itself stays put`, over.doc <= over.seen, `${over.doc} > ${over.seen}`);
    const end = await far(page, "unbreakable");
    ok(`unbreakable · scrolled to the end, the last column is whole ("${end.label}")`, end.inside, "clipped");
    await page.waitForTimeout(150);
    await shot(page, "unbreakable", `unbreakable-scrolled-${theme}`);
    await page.close();
  }

  /* ── Everything else in a reply, for the comparison ──────────────────
     Nothing here is a table, so these two pictures are expected to be the
     same file on both sides of the change. */
  {
    const page = await open(theme, "prose");
    await shot(page, "prose", `prose-desk-${theme}`);
    await page.close();
  }
}

await browser.close();
console.log(failed ? `\n  ${failed} assertion(s) failed\n` : `\n  all assertions held · ${OUT}\n`);
process.exit(failed ? 1 : 0);
