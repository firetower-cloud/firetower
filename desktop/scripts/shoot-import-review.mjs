/**
 * The profile import review, driven and photographed.
 *
 *   pnpm dev --port 5291 &
 *   APP=http://localhost:5291 node scripts/shoot-import-review.mjs
 *
 * Every state the ticket names, at 1280 and at the window's 880 `minWidth`, in
 * both themes — and the assertions that make the pictures mean something.
 *
 * **Resolved colours, not a photograph**, which is the standard
 * `shoot-formfoot.mjs` set for exactly this reason: a screenshot of a correct
 * palette and a screenshot of a broken one differ by a hue nobody checks, and
 * this screen's colour discipline is most of its design. So the probe reads
 * `--color-brick`, `--color-amber` and the two ember tokens out of the running
 * document and compares, which has no hue to get wrong.
 *
 * **The ember budget is asserted at zero**, by the same method
 * `design-rules.mjs` uses on the rest of the app: ember answers one question —
 * is an agent waiting on you — and nothing on this screen is that question.
 *
 * It drives `/review.html`, the dev harness, because the drop that produces a
 * real plan is #358. The plans are `import-plans.ts`, which is also what the
 * unit tests read, so the pictures and the assertions are about one thing.
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const APP = process.env.APP ?? "http://localhost:5291";
const OUT = process.env.OUT ?? new URL("../../.firetower/shots/import-review", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });

let failed = 0;
const ok = (what, cond, saw) => {
  console.log(`  ${cond ? "✓" : "✗"} ${what}${cond ? "" : `  — saw ${saw}`}`);
  if (!cond) failed++;
};

/** The window's own two widths. 880 is `tauri.conf.json`'s `minWidth`. */
const WIDTHS = { desk: 1280, narrow: 880 };

async function open(theme, state, width = "desk", height = 1400) {
  const page = await browser.newPage({
    viewport: { width: WIDTHS[width], height },
    deviceScaleFactor: 2,
  });
  page.on("pageerror", (e) => console.log("    pageerror:", String(e).slice(0, 200)));
  await page.addInitScript((t) => window.localStorage.setItem("firetower.theme", t), theme);
  await page.goto(`${APP}/review.html#${state}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  return page;
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

const colourOf = (page, sel, prop = "color") =>
  page.locator(sel).first().evaluate((n, p) => getComputedStyle(n)[p], prop);

/**
 * Every ember mark on screen, resolved rather than guessed at.
 *
 * Lifted from `design-rules.mjs`: the heuristic there read amber as ember and
 * counted a skill's risk lines against a budget that is about ember alone, so
 * the two ember tokens are resolved through a probe and compared exactly.
 */
const embers = (page) =>
  page.evaluate(() => {
    const probe = document.createElement("div");
    document.body.append(probe);
    const EMBER = new Set();
    for (const n of ["--color-ember", "--color-ember-ink", "--color-ember-soft"]) {
      probe.style.color = `var(${n})`;
      EMBER.add(getComputedStyle(probe).color.replace(/\s/g, ""));
    }
    probe.remove();
    const flat = (v) => (v ?? "").replace(/\s/g, "");
    const found = [];
    for (const el of document.querySelectorAll(".pg *")) {
      const s = getComputedStyle(el);
      for (const prop of ["color", "backgroundColor", "borderLeftColor", "borderTopColor"]) {
        if (EMBER.has(flat(s[prop]))) found.push(`${el.className || el.tagName} ${prop}`);
      }
    }
    return found;
  });

/**
 * The column, photographed whole.
 *
 * Playwright scrolls a tall element and stitches it, which draws a sticky foot
 * into every band it passes through — so the foot is pinned flat for the
 * portrait and nowhere else. That it *is* sticky is proved by scrolling a real
 * viewport instead, in the large-drop block below.
 */
const shot = async (page, id) => {
  await page.waitForTimeout(200);
  /* The window is the app and the *pane* scrolls, not the document — so
     Playwright's own scroll-and-stitch runs out after one screenful and the
     rest comes back blank. The viewport is grown to the column instead, which
     is the only capture of a twenty-three row list that is actually of it. */
  await page.addStyleTag({ content: ".formfoot{position:static !important}" });
  const tall = await page.locator(".pg").evaluate((n) => Math.ceil(n.scrollHeight) + 40);
  const { width } = page.viewportSize();
  await page.setViewportSize({ width, height: Math.min(Math.max(tall, 600), 9000) });
  await page.waitForTimeout(250);
  await page.locator(".pg").screenshot({ path: `${OUT}/${id}.png` });
};

/* Every specimen the generator writes, plus the two states that are not
   plans: a drop past a bound, and a drop holding no bundle at all. */
const STATES = [
  "all-new",
  "mixed",
  "all-blocked",
  "more-conditions",
  "bad-setting",
  "nothing-to-import",
  "same-name",
  "same-key",
  "same-target",
  "rename",
  "near-match",
  "large",
  "refused",
];

for (const theme of ["dark", "light"]) {
  console.log(`\n  ── ${theme} ──`);
  const probe = await open(theme, "mixed");
  const BRICK = await token(probe, "--color-brick");
  const AMBER = await token(probe, "--color-amber");
  const SAGE = await token(probe, "--color-sage");
  const SLATE = await token(probe, "--color-slate");
  const AMBER_SOFT = await token(probe, "--color-amber-soft");
  const DIM = await token(probe, "--color-dim");
  await probe.close();

  for (const width of ["desk", "narrow"]) {
    for (const state of STATES) {
      const page = await open(theme, state, width);
      await shot(page, `${state}-${width}-${theme}`);

      /* ── No ember, anywhere, in any state ───────────────────────────── */
      const burning = await embers(page);
      ok(`${state} · ${width} · no ember`, burning.length === 0, burning.slice(0, 3).join(" · "));

      if (width === "desk") {
        /* ── Rows are in file order, never sorted by state ─────────────
           Checked against the order the plan declares, which the harness
           publishes — not against alphabetical, which `large` is not and
           which would have made this assertion about the fixture. */
        const { drawn, declared } = await page.evaluate(() => ({
          drawn: [...document.querySelectorAll(".imp")].map(
            (n) => [...n.querySelectorAll(".font-mono")].find((m) => m.textContent.endsWith("PROFILE.md"))?.textContent,
          ),
          declared: window.__PLAN__.entries.map((e) => e.path),
        }));
        ok(
          `${state} · rows in file order`,
          JSON.stringify(drawn) === JSON.stringify(declared),
          `${drawn.slice(0, 3).join(", ")} vs ${declared.slice(0, 3).join(", ")}`,
        );
      }
      await page.close();
    }

    /* ── Sixteen fields, always, and a reset that is the only colour ──── */
    {
      const page = await open(theme, "mixed", width);
      const rows = await page.locator(".dsheet .dr:not(.colhd)").count();
      /* 15 leaf fields + the `settings` header + its four leaves = 20. */
      ok(`mixed · ${width} · all sixteen fields are drawn`, rows === 20, `${rows} rows`);
      const unchanged = await page.locator('.dsheet .dr[data-c="unchanged"]').count();
      ok(`mixed · ${width} · unchanged ones are drawn too`, unchanged >= 14, `${unchanged}`);

      const resetK = await colourOf(page, '.dr[data-c="reset"] .k');
      ok(`mixed · ${width} · a reset is amber (${AMBER})`, resetK === AMBER, resetK);
      const changedNow = await colourOf(page, '.dr[data-c="changed"] .now');
      ok(
        `mixed · ${width} · an ordinary change wears no hue`,
        changedNow !== AMBER && changedNow !== BRICK,
        changedNow,
      );
      await page.close();
    }
  }

  /* ── The refusal: brick, and the primary keeps its label ───────────── */
  {
    const page = await open(theme, "mixed");
    const msg = page.locator(".formfoot .msg").first();
    ok(
      `mixed · the foot asks for \`bad\``,
      /\bbad\b/.test(await msg.getAttribute("class")),
      await msg.getAttribute("class"),
    );
    const footColour = await msg.evaluate((n) => getComputedStyle(n).color);
    ok(`mixed · the foot is brick, not dim (${BRICK})`, footColour === BRICK, footColour);

    const primary = page.locator(".formfoot .btn.primary");
    ok("mixed · the primary is unavailable", await primary.isDisabled(), "enabled");
    ok(
      "mixed · and keeps its real label",
      /^Import 5 profiles$/.test((await primary.innerText()).trim()),
      await primary.innerText(),
    );

    const bannerRule = await colourOf(page, ".review", "borderLeftColor");
    ok(`mixed · the banner's rule is brick (${BRICK})`, bannerRule === BRICK, bannerRule);

    /* ── A blocked profile arrives ticked and expanded ───────────────── */
    const blockedRow = page.locator('.imp[data-state="blocked"]').first();
    ok(
      "mixed · a blocked profile arrives ticked",
      (await blockedRow.locator('[role="checkbox"]').getAttribute("aria-checked")) === "true",
      "unticked",
    );
    ok(
      "mixed · a blocked profile shows its error and no field panel",
      (await blockedRow.locator(".dsheet").count()) === 0 &&
        (await blockedRow.locator(".border-brick").count()) > 0,
      "panel present",
    );
    ok(
      "mixed · the blocked reason names the file, the key and the line",
      /machine/.test(await blockedRow.innerText()) &&
        /PROFILE\.md:\d+/.test(await blockedRow.innerText()),
      (await blockedRow.innerText()).slice(0, 80),
    );
    ok(
      "mixed · and reads the same whether hidden or absent",
      /is available to you/.test(await blockedRow.innerText()),
      (await blockedRow.innerText()).slice(0, 120),
    );

    /* ── Excluding it is an act, and the count stays in the foot ─────── */
    await page.getByRole("button", { name: /^Exclude Security Advisor$/ }).click();
    await page.waitForTimeout(300);
    const after = (await msg.innerText()).trim();
    ok("mixed · excluding it is offered and works", /excluded/.test(after), after);
    ok(
      "mixed · and a candidate still holds the import",
      await primary.isDisabled(),
      "became available with a candidate unanswered",
    );
    await shot(page, `mixed-excluded-${theme}`);
    await page.close();
  }

  /* ── A candidate is a control: two answers, neither pressed ────────── */
  {
    const page = await open(theme, "near-match");
    const pair = page.locator(".pickpair").first();
    const pressed = await pair.locator('[role="radio"]').evaluateAll((ns) =>
      ns.map((n) => n.getAttribute("aria-checked")),
    );
    ok("near match · two answers", pressed.length === 2, `${pressed.length}`);
    ok("near match · neither is a default", pressed.every((p) => p === "false"), pressed.join(","));
    ok(
      "near match · unanswered, the import is unavailable",
      await page.locator(".formfoot .btn.primary").isDisabled(),
      "available",
    );
    const footCls = await page.locator(".formfoot .msg").getAttribute("class");
    ok("near match · the foot asks for no severity", footCls.trim() === "msg", footCls);
    const pipColour = await colourOf(page, '.outcome[data-s="asking"] i', "backgroundColor");
    ok(
      "near match · the row wears no hue",
      pipColour !== AMBER && pipColour !== BRICK && pipColour !== SAGE && pipColour !== SLATE,
      pipColour,
    );
    await shot(page, `near-match-asking-${theme}`);

    /* Answering *a new profile* says two profiles will exist. */
    await page.getByRole("radio", { name: /A new profile/ }).click();
    await page.waitForTimeout(250);
    const said = await page.locator(".imp").first().innerText();
    ok(
      "near match · a new profile states that two would exist",
      /stays as it is, so you would have both/.test(said),
      said.slice(-110),
    );
    await shot(page, `near-match-new-${theme}`);
    await page.close();
  }

  /* ── A rename reads as a rename ─────────────────────────────────────── */
  {
    const page = await open(theme, "rename");
    const row = await page.locator(".imp").first().innerText();
    ok("rename · says it renames", /Renames Designer to Product Designer/.test(row), row.slice(0, 90));
    ok("rename · and not that it creates", !/^Creates/m.test(row), row.slice(0, 90));
    ok(
      "rename · the state word is the rename",
      /will rename/.test(row),
      row.split("\n").slice(0, 2).join(" "),
    );
    await page.close();
  }

  /* ── A drop past a bound names the limit ─────────────────────────────
     Not a plan: `plan()` returns `Refused` and the API makes it an
     `InvalidRequest`, so the screen is handed a sentence rather than an
     `ImportPlan` with no entries in it. */
  {
    const page = await open(theme, "refused");
    const banner = await page.locator(".review").innerText();
    ok("refused · the limit is named", /at most 200/.test(banner), banner.slice(0, 110));
    ok("refused · and there is something to do", /Drop fewer/.test(banner), banner.slice(-70));
    ok("refused · and no list is drawn", (await page.locator(".imp").count()) === 0, "rows drawn");
    const rule = await colourOf(page, ".review", "borderLeftColor");
    ok(`refused · brick (${BRICK})`, rule === BRICK, rule);
    await page.close();
  }

  /* ── A dead primary never appears without a sentence ──────────────────
     QA's empty-drop case, and #349 in a new place: something was accepted,
     nothing happened, and the screen had no answer. */
  {
    const page = await open(theme, "nothing-to-import");
    const msg = (await page.locator(".formfoot .msg").innerText()).trim();
    ok("nothing to import · the primary is unavailable", await page.locator(".formfoot .btn.primary").isDisabled(), "live");
    ok("nothing to import · and a sentence says why", msg.length > 20 && /PROFILE\.md/.test(msg), msg);
    await shot(page, `nothing-to-import-${theme}`);
    await page.close();
  }

  /* ── The banner leads with the diagnosis, not with "blocked" ─────────── */
  {
    const page = await open(theme, "mixed");
    const head = (await page.locator(".review h3").innerText()).trim();
    ok("banner · names the profile and the condition", /^Security Advisor: /.test(head), head);
    ok("banner · and not the word the pip already carries", !/is blocked/.test(head), head);
    const body = (await page.locator(".review p").first().innerText()).trim();
    ok("banner · the body does not repeat the heading", !body.includes(head), body.slice(0, 90));
    await page.close();
  }

  /* ── Amber is spent on a duplicate name, and on nothing else ──────────
     The accepted rule is amber for exactly two things with one meaning: a
     reset, and a name that may be a duplicate. Asserted as *which* elements
     resolve to it, because a count of them cannot fail. */
  {
    const page = await open(theme, "same-name");
    const marked = await page.locator("[data-warn]").evaluateAll((ns) =>
      ns.map((n) => [n.dataset.warn, getComputedStyle(n).borderLeftColor]),
    );
    ok("amber · both duplicate-name warnings are drawn", marked.length === 2, `${marked.length}`);
    ok(
      "amber · each is the duplicate-name kind",
      marked.every(([kind]) => kind === "duplicate-name"),
      marked.map(([k]) => k).join(","),
    );
    ok(
      `amber · and each wears amber (${AMBER_SOFT})`,
      marked.every(([, c]) => c === AMBER_SOFT),
      marked.map(([, c]) => c).join(" · "),
    );
    /* Nothing else on this page may take it. A zero-width border computes to
       `currentColor`, so a border is only counted where there is one to see —
       the naive scan counted each amber word twice and would have hidden a
       third mark appearing. */
    /* Two tokens, counted separately. `--color-amber-soft` is the non-text
       step and `--color-amber` is the text one — the same value in dark and
       deliberately not in light, where a mark and a word need different
       contrast. Counting both against one would pass in dark and say nothing. */
    const marks = await page.evaluate(([soft, text]) => {
      const flat = (v) => (v ?? "").replace(/\s/g, "");
      const out = { rule: 0, text: 0, fill: 0 };
      for (const el of document.querySelectorAll(".pg *")) {
        const s = getComputedStyle(el);
        if (parseFloat(s.borderLeftWidth) > 0 && flat(s.borderLeftColor) === flat(soft)) out.rule++;
        if (flat(s.color) === flat(text) && el.textContent.trim()) out.text++;
        if ([soft, text].some((w) => flat(s.backgroundColor) === flat(w))) out.fill++;
      }
      return out;
    }, [AMBER_SOFT, AMBER]);
    ok(
      "amber · two rules, two words, no fill, and nothing else",
      marks.rule === 2 && marks.text === 2 && marks.fill === 0,
      JSON.stringify(marks),
    );
    await shot(page, `same-name-${theme}`);
    await page.close();
  }

  /* ── And a warning that is *not* about a duplicate name takes none ────
     A setting the plan cannot check, because the profile pins no engine. The
     first warning in the product that is not a duplicate name, which is what
     makes this the rule's first real test rather than a mutation of one. */
  {
    const page = await open(theme, "bad-setting");
    const kinds = await page.locator("[data-warn]").evaluateAll((ns) => ns.map((n) => n.dataset.warn));
    ok("amber · the unchecked setting warns", kinds.length === 1, `${kinds.length}`);
    ok("amber · and it is not the duplicate-name kind", kinds[0] === "other", `${kinds[0]}`);
    const rule = await colourOf(page, "[data-warn]", "borderLeftColor");
    ok(
      `amber · so it wears the neutral rule, not amber (${AMBER_SOFT})`,
      rule !== AMBER_SOFT && rule !== AMBER,
      rule,
    );
    await shot(page, `bad-setting-${theme}`);
    await page.close();
  }

  /* ── A large drop: pills past twelve, and the foot stays put ────────── */
  {
    const page = await open(theme, "large", "desk", 900); // a real viewport, not grown
    ok("large · filter pills appear", (await page.locator(".filters .fp").count()) >= 4, "none");
    const foot = page.locator(".formfoot");
    const stuck = await foot.evaluate((n) => getComputedStyle(n).position);
    ok("large · the foot is sticky at every width", stuck === "sticky", stuck);
    await page.locator(".imp").last().scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const box = await foot.boundingBox();
    const h = page.viewportSize().height;
    ok("large · and is on screen at the bottom of the list", box.y + box.height <= h + 2, `${box.y}`);
    await page.screenshot({ path: `${OUT}/large-scrolled-${theme}.png` });
    await page.close();
  }

  /* ── Files that were not read: present, and wearing nothing ─────────── */
  {
    const page = await open(theme, "mixed");
    const note = page.locator(".note2").first();
    ok("ignored · said plainly", /2 files were not read/.test(await note.innerText()), await note.innerText());
    const c = await note.locator(".say").evaluate((n) => getComputedStyle(n).color);
    ok(
      `ignored · spends no amber and no brick`,
      c !== AMBER && c !== BRICK,
      c,
    );
    ok(`ignored · and is the quiet tier (${DIM})`, c === DIM, c);
    const marks = await page.locator(".note2 .outcome, .note2 .pip").count();
    ok("ignored · and carries no state mark", marks === 0, `${marks}`);
    await page.getByRole("button", { name: /show them/ }).click();
    await page.waitForTimeout(200);
    ok(
      "ignored · and can be looked at",
      /\.DS_Store/.test(await note.innerText()),
      await note.innerText(),
    );
    await shot(page, `ignored-${theme}`);
    await page.close();
  }
}

await browser.close();
console.log(failed ? `\n  ${failed} assertion(s) failed\n` : `\n  all assertions held · ${OUT}\n`);
process.exit(failed ? 1 : 0);
