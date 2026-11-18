/**
 * Release channels on the Updates screen, driven and photographed.
 *
 *   pnpm dev --port 5292 &
 *   APP=http://localhost:5292 node scripts/shoot-channels.mjs
 *
 * Every state the ticket names, at the prototype's three widths and at 380,
 * in both themes — and the assertions that make the pictures mean something.
 *
 * **The one thing this is really for.** One screen now carries two controls
 * that both say *channel* and mean different things: the installation's,
 * which is an administrator's and moves everybody, and this copy's, which is a
 * preference on this machine. The whole design rests on them not being
 * confusable, and the way they are kept apart is *weight* — a section with a
 * heading, rows, a block and a panel against one segmented control with a
 * sentence under it. So that asymmetry is measured rather than looked at: the
 * install-wide control's height, its heading, its per-channel rows, against
 * the per-copy control being a single `.seg`.
 *
 * **The ember budget is asserted at zero**, by `design-rules.mjs`'s own
 * method. Ember answers one question — is an agent waiting on you — and
 * nothing here is that question. A channel is not a colour.
 *
 * It drives `/channels.html`, the dev harness, because reaching these states
 * in the product needs a control plane on the channels branch with an updater
 * beside it. The specimens are `ui/updates/channel-states.ts`, which is also
 * what the unit tests read, so the pictures and the assertions are about one
 * thing.
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const APP = process.env.APP ?? "http://localhost:5292";
const OUT = process.env.OUT ?? new URL("../../.firetower/shots/channels", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });

/**
 * Text as a sentence, not as a box model.
 *
 * `innerText` inserts a newline wherever the layout has a break — every flex
 * item is one — so a sentence with a `<span>` in it arrives in pieces, and a
 * regex written as prose matches or does not depending on where the line
 * happened to wrap. This cost one false green before it was noticed.
 */
const flat = (t) => t.replace(/\s+/g, " ").trim();

let failed = 0;
const ok = (what, cond, saw) => {
  console.log(`  ${cond ? "✓" : "✗"} ${what}${cond ? "" : `  — saw ${saw}`}`);
  if (!cond) failed++;
};

/**
 * The widths. The first three are the prototype's own — 1280 is the window's
 * opening size and 880 its `minWidth` from `tauri.conf.json`. 380 is below
 * anything the window can be, so it is the page rather than the application:
 * drawn because a row that collapses there is a row with no give in it.
 */
const WIDTHS = { w1280: 1280, w1024: 1024, w880: 880, w380: 380 };

async function open(theme, state, width = "w1280", height = 1200) {
  const page = await browser.newPage({ viewport: { width: WIDTHS[width], height }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => console.log("    pageerror:", String(e).slice(0, 200)));
  await page.addInitScript((t) => window.localStorage.setItem("firetower.theme", t), theme);
  await page.goto(`${APP}/channels.html#${state}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(350);
  return page;
}

/** The column, photographed whole — the pane scrolls, not the document. */
const shot = async (page, id) => {
  await page.waitForTimeout(150);
  const tall = await page.locator(".pg").evaluate((n) => Math.ceil(n.scrollHeight) + 40);
  const { width } = page.viewportSize();
  await page.setViewportSize({ width, height: Math.min(Math.max(tall, 600), 9000) });
  await page.waitForTimeout(200);
  await page.locator(".pg").screenshot({ path: `${OUT}/${id}.png` });
};

/** Every ember mark on screen, resolved rather than guessed at. */
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

/** Does anything overflow the column sideways? The 380 case is what asks. */
const spilling = (page) =>
  page.evaluate(() => {
    const column = document.querySelector(".pg");
    const right = column.getBoundingClientRect().right;
    const out = [];
    for (const el of column.querySelectorAll("*")) {
      const box = el.getBoundingClientRect();
      /* Anything with its own sideways scroll is allowed past: a diff line
         and a version cell never wrap, which is the house rule for code. */
      if (box.width === 0) continue;
      const style = getComputedStyle(el);
      if (style.overflowX === "auto" || style.overflowX === "scroll") continue;
      if (el.closest(".prose-diff")) continue;
      if (box.right > right + 1) out.push(`${el.className || el.tagName} ${Math.round(box.right - right)}px`);
    }
    return out.slice(0, 5);
  });

/**
 * Text painted outside the box that is supposed to hold it.
 *
 * **`spilling()` could not see this and that is the point.** It measures
 * boxes, so a 7x7px cell with 212px of text painted out of it has a box
 * entirely inside the column and passes — which is exactly what happened:
 * `.chan .st` inherited an unscoped 7px status dot's width and height, and
 * every verdict on every channel row was broken at every width a window can
 * be, in all 166 screenshots, under a green assertion. An assertion only ever
 * checks the thing you thought to measure.
 *
 * So this measures the other thing: a Range over the element's own text nodes
 * gives the rectangle the glyphs actually occupy, and that is compared with
 * the element's border box. Anything that scrolls or clips on purpose is
 * excluded — a diff line, a truncated path — because those overflow by
 * design; what is caught is text with nowhere to go.
 */
const painting = (page) =>
  page.evaluate(() => {
    const out = [];
    const SLACK = 2; // sub-pixel rounding, and a descender or two
    for (const el of document.querySelectorAll(".pg *")) {
      const text = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());
      if (text.length === 0) continue;
      const style = getComputedStyle(el);
      if (style.overflow !== "visible" || style.textOverflow === "ellipsis") continue;
      if (el.closest(".prose-diff")) continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      const range = document.createRange();
      let widest = 0;
      let tallest = 0;
      for (const node of text) {
        range.selectNodeContents(node);
        const ink = range.getBoundingClientRect();
        widest = Math.max(widest, ink.right - box.right, box.left - ink.left);
        tallest = Math.max(tallest, ink.bottom - box.bottom, box.top - ink.top);
      }
      range.detach?.();
      if (widest > SLACK || tallest > SLACK) {
        out.push(
          `${el.className || el.tagName} "${el.textContent.trim().slice(0, 30)}" ` +
            `${Math.round(Math.max(widest, tallest))}px outside a ${Math.round(box.width)}x${Math.round(box.height)} box`,
        );
      }
    }
    return out.slice(0, 5);
  });

const STATES = [
  "general",
  "beta",
  "frozen",
  "unrecognised",
  "pinned",
  "noUpdater",
  "member",
  "manifestUnreadable",
  "manifestVanished",
  "manifestAbsent",
  "oldServer",
  "switch",
  "pin",
  "plan",
  "planlong",
  "b1",
  "b2",
  "b3",
  "b4",
  "downloading",
];

for (const theme of ["dark", "light"]) {
  console.log(`\n  ── ${theme} ──`);

  for (const width of Object.keys(WIDTHS)) {
    for (const state of STATES) {
      const page = await open(theme, state, width);
      await shot(page, `${state}-${width}-${theme}`);

      /* ── No ember, anywhere, in any state ─────────────────────────────
         A channel is identified by position, shape and weight. If it ever
         becomes a hue, this is what says so. */
      const burning = await embers(page);
      ok(`${state} · ${width} · no ember`, burning.length === 0, burning.slice(0, 3).join(" · "));

      /* ── Nothing spills out of the column ─────────────────────────────
         The 380 case is the one that asks; it is run at every width so a
         regression at 880 is not hidden by the narrow one passing. */
      const over = await spilling(page);
      ok(`${state} · ${width} · nothing spills sideways`, over.length === 0, over.join(" · "));

      /* ── And nothing paints outside the box meant to hold it ──────────
         The one `spilling` structurally cannot see. Run at every width,
         because the collision it exists for was broken at all of them. */
      const outside = await painting(page);
      ok(`${state} · ${width} · no text painted outside its box`, outside.length === 0, outside.join(" · "));

      await page.close();
    }
  }

  /* ── The two controls are not confusable ────────────────────────────────
     Measured, not looked at. The install-wide one is a section with a
     heading and a row per channel; the per-copy one is one `.seg` in a row
     with one sentence. */
  {
    const page = await open(theme, "general");
    const install = page.locator("section.upd-sec").filter({ hasText: "Channel for this Firetower" });
    const copy = page.locator('section.upd-sec[data-part="B"]');

    ok("asymmetry · the installation's channel is a section with a heading", (await install.locator("h2").innerText()).trim() === "Channel for this Firetower", await install.locator("h2").innerText());
    ok("asymmetry · with a row per channel", (await install.locator(".chan").count()) === 2, `${await install.locator(".chan").count()}`);
    ok("asymmetry · the copy's channel is one segmented control", (await copy.locator(".seg").count()) === 1, `${await copy.locator(".seg").count()}`);
    ok("asymmetry · and has no per-channel rows of its own", (await copy.locator(".chan").count()) === 0, `${await copy.locator(".chan").count()}`);

    const tall = await install.evaluate((n) => n.getBoundingClientRect().height);
    const small = await copy.locator(".seg").evaluate((n) => n.getBoundingClientRect().height);
    ok(`asymmetry · the irreversible one is far heavier (${Math.round(tall)}px vs ${Math.round(small)}px)`, tall > small * 3, `${Math.round(tall)} vs ${Math.round(small)}`);

    /* The words the screen already uses, which is how the two are told
       apart in prose as well as in weight. */
    const said = await page.locator(".pg").innerText();
    ok("asymmetry · the words are This Firetower and This app", /Channel for this Firetower/.test(said) && /Channel for this copy/.test(said), said.slice(0, 80));
    await page.close();
  }

  /* ── A member sees a fact and no control ────────────────────────────── */
  {
    const page = await open(theme, "member");
    const install = page.locator("section.upd-sec").filter({ hasText: "Channel for this Firetower" });
    ok("member · the installation's channel is still drawn", (await install.locator(".chan").count()) === 2, "hidden");
    ok("member · with no control on it", (await install.locator("button").count()) === 0, `${await install.locator("button").count()} buttons`);
    ok("member · and the mark is still on the one in force", (await install.locator('.chan[data-on="true"]').count()) === 1, "no mark");
    const said = await install.innerText();
    /* **The longest verdict in the set, measured on purpose.** "You do not
       administer this Firetower" is 212px of text and was being painted out
       of a 7px box; it is the string any future collision on this cell breaks
       first, so it is asserted by name rather than only by the sweep above. */
    const verdict = install.locator(".verdict").filter({ hasText: "do not administer" });
    const fits = await verdict.evaluate((n) => {
      const box = n.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(n);
      const ink = range.getBoundingClientRect();
      return { box: Math.round(box.width), ink: Math.round(ink.width) };
    });
    ok(
      `member · the longest verdict has a box to sit in (${fits.ink}px of text, ${fits.box}px box)`,
      fits.box >= fits.ink - 2,
      `${fits.ink}px in ${fits.box}px`,
    );
    ok("member · says whose it is", /changing it is an administrator's/.test(said), said.slice(-120));
    ok("member · and points at their own copy's channel", /Your own copy of the app has its own channel/.test(said), said.slice(-120));
    /* Theirs is still theirs. */
    const copy = page.locator('section.upd-sec[data-part="B"]');
    ok("member · their own copy's channel is still a control", (await copy.locator(".seg button").count()) === 2, "absent");
    await page.close();
  }

  /* ── The frozen pin names the cause and the tag to use ───────────────── */
  {
    const page = await open(theme, "frozen");
    const block = page.locator(".review").first();
    const said = await block.innerText();
    ok("frozen · names the tag it is pinned to", /:latest/.test(said), said.slice(0, 120));
    ok("frozen · names the real cause", /follows the newest build published/.test(said), said.slice(0, 200));
    /* **The tag to use, in the instruction and not only in the table.**
       The first version of this asserted `:stable` was somewhere in the
       block — which the tag table alone satisfies, so deleting the sentence
       that tells an operator what pinning *does* left it green. #388's rule
       found it. The table and the instruction are now asserted apart. */
    const wanted = block.locator(".diffrow").filter({ hasText: "wanted" });
    ok("frozen · the table names the tag to use", /:stable/.test(await wanted.innerText()), await wanted.innerText());
    ok(
      "frozen · and the instruction says what pinning it does",
      /Pinning :stable leaves this installation where it is and lets it move again/.test(flat(said)),
      flat(said).slice(-240),
    );
    ok("frozen · offers the fix", /Pin :stable/.test(said), said.slice(-120));
    const rule = await block.evaluate((n) => getComputedStyle(n).borderLeftColor);
    const amber = await page.evaluate(() => {
      const p = document.createElement("span");
      p.style.color = "var(--color-amber-soft)";
      document.body.append(p);
      const c = getComputedStyle(p).color;
      p.remove();
      return c;
    });
    ok(`frozen · reads as something to act on (${amber})`, rule === amber, rule);
    /* And no upgrade button, because the upgrade would refuse. */
    ok("frozen · no upgrade button where the upgrade would refuse", !/Upgrade to/.test(await page.locator(".upd-row").first().innerText()), await page.locator(".upd-row").first().innerText());
    await page.close();
  }

  /* ── The switch states what it means, and offers the backup first ────── */
  {
    const page = await open(theme, "switch");
    const warn = page.locator(".review").first();
    const said = await warn.innerText();
    /* **The corrected position.** "One-way" is superseded: the refusal is
       about the version, not about membership of a channel. */
    ok("switch · the consequence is stated before the control", await warn.isVisible(), "absent");
    ok("switch · as a version fact, not a channel one", /older version/.test(said), said.slice(0, 220));
    ok("switch · and says what ends it", /once general access reaches/i.test(said), said.slice(0, 260));
    ok("switch · never claims leaving is impossible", !/cannot be undone|one-way|one way/i.test(said), said.slice(0, 260));
    ok("switch · offers a backup in the same breath", (await warn.getByRole("button", { name: /Back up now/ }).count()) === 1, "no backup");

    /* The backup is above the primary, which is at the bottom where the
       reading ends. */
    const warnBox = await warn.boundingBox();
    const go = page.locator(".foot .btn.primary");
    const goBox = await go.boundingBox();
    ok("switch · the warning is above the button that takes it", warnBox.y < goBox.y, `${warnBox.y} vs ${goBox.y}`);
    ok("switch · the button says what it does", /Switch to beta and upgrade to 0\.56\.0/.test(await go.innerText()), await go.innerText());

    /* The diff is the deployment file's, and both image lines are in it. */
    await page.getByRole("button", { name: /firetower\.yml/ }).click();
    await page.waitForTimeout(200);
    const diff = await page.locator(".prose-diff").innerText();
    ok("switch · shows the deployment-file diff", /image:/.test(diff), diff.slice(0, 80));
    ok("switch · both image lines, not one", (diff.match(/^\+\s*image:/gm) ?? []).length === 2, `${(diff.match(/^\+\s*image:/gm) ?? []).length}`);
    await shot(page, `switch-open-${theme}`);
    await page.close();
  }

  /* ── The span: every jumped version, and the shortfall named ─────────── */
  {
    const page = await open(theme, "plan");
    const rows = await page.locator(".span .vrow").count();
    ok("span · one row per version in the jump", rows === 6, `${rows}`);
    ok("span · and no shortfall when the span is whole", (await page.locator(".span .short").count()) === 0, "named one anyway");
    await page.getByRole("button", { name: /0\.54\.0/ }).click();
    await page.waitForTimeout(200);
    ok("span · a row opens to its section", (await page.locator(".span .body li").count()) > 0, "empty");
    await shot(page, `plan-open-${theme}`);
    await page.close();
  }
  {
    const page = await open(theme, "planlong");
    const short = page.locator(".span .short");
    ok("span · a span over the cap names the shortfall", await short.isVisible(), "absent");
    const said = await short.innerText();
    ok("span · says where the sections stop", /are not shown/.test(said), said);
    ok("span · and links the full comparison", (await short.locator("a").count()) === 1, "no link");
    /* The rows scroll; the shortfall does not. A count somebody has to
       scroll to is a count they do not see. */
    const scrolls = await page.locator(".span .rows").evaluate((n) => n.scrollHeight > n.clientHeight + 1);
    ok("span · the rows take their own scroll past the cap", scrolls, "pushed the panel instead");
    await page.close();
  }

  /* ── Ahead of general access: a state, not an error ──────────────────── */
  {
    const page = await open(theme, "b3");
    const block = page.locator('section[data-part="B"] .review');
    ok("ahead · is a named state", /Ahead of general access/.test(await block.innerText()), await block.innerText());
    const rule = await block.evaluate((n) => getComputedStyle(n).borderLeftColor);
    const brick = await page.evaluate(() => {
      const p = document.createElement("span");
      p.style.color = "var(--color-brick)";
      document.body.append(p);
      const c = getComputedStyle(p).color;
      p.remove();
      return c;
    });
    ok("ahead · and is not drawn as a failure", rule !== brick, rule);
    const said = await block.innerText();
    ok("ahead · says what would end it", /Updates start again when general access reaches 0\.30\.0/.test(said), said.slice(-200));
    ok("ahead · and that a check finding nothing is right", /check finding nothing is the right answer/.test(said), said.slice(-120));
    /* Nothing offers to put an older build over this one. */
    const row = await page.locator('section[data-part="B"] .upd-row').first().innerText();
    ok("ahead · nothing offers a downgrade", !/Update to 0\.29/.test(row), row);
    await page.close();
  }

  /* ── The two channels disagreeing is supported, and does not nag ─────── */
  {
    const page = await open(theme, "b4");
    const said = await page.locator('section[data-part="B"]').innerText();
    ok("disagree · one line states it", /That is supported/.test(said), said.slice(0, 200));
    const warnings = await page.locator('section[data-part="B"] .review[data-tone="amber"]').count();
    ok("disagree · and nothing warns about it", warnings === 0, `${warnings} amber blocks`);
    await page.close();
  }

  /* ── An older control plane: no control it cannot serve ──────────────── */
  {
    const page = await open(theme, "oldServer");
    ok("old server · no channel section at all", (await page.locator(".chan").count()) === 0, "drew one");
    const said = await page.locator(".note2").first().innerText();
    ok("old server · names both versions", /0\.30\.1/.test(said) && /0\.28\.1/.test(said), said);
    /* And the copy's own channel is untouched by it. */
    ok("old server · the copy's channel still works", (await page.locator('section[data-part="B"] .seg button').count()) === 2, "absent");
    await page.close();
  }

  /* ── A copy's channel change takes effect without a restart ──────────── */
  {
    const page = await open(theme, "b1");
    const seg = page.locator('section[data-part="B"] .seg');
    ok("copy · starts on general access", (await seg.locator('[aria-pressed="true"]').innerText()) === "General access", await seg.locator('[aria-pressed="true"]').innerText());
    await seg.getByRole("button", { name: "Beta" }).click();
    await page.waitForTimeout(250);
    ok("copy · the choice is live, not a picture of one", (await seg.locator('[aria-pressed="true"]').innerText()) === "Beta", await seg.locator('[aria-pressed="true"]').innerText());
    const said = await page.locator('section[data-part="B"] .upd-row').nth(1).innerText();
    ok("copy · and says what leaving does, where somebody is deciding", /Switching back stops new betas/.test(said), said);
    await shot(page, `b1-beta-${theme}`);
    await page.close();
  }

  /* ── The manifest that would not read: never a zero ──────────────────── */
  {
    const page = await open(theme, "manifestUnreadable");
    const said = flat(await page.locator("section.upd-sec").filter({ hasText: "Channel for this Firetower" }).innerText());
    ok("manifest · says there is no version rather than inventing one", /No version yet/.test(said), said.slice(0, 200));
    ok("manifest · never shows a zero", !/0\.0\.0/.test(said), said.slice(0, 200));
    /* The server's own sentence, said once — in the block, not also under
       the rows, where it would be the same paragraph twice. */
    const block = flat(await page.locator(".review").first().innerText());
    ok("manifest · and says why nothing may move", /429/.test(block), block.slice(0, 200));
    ok("manifest · and says it only once", !/429/.test(said), said.slice(-200));
    await page.close();
  }

  /* ── A destroyed manifest does not read like a failed read ───────────
     Both refuse and move nothing, so the words are the only difference a
     person ever sees. If they ever read alike the distinction has bought
     nothing, which is what this measures. */
  {
    const gone = await open(theme, "manifestVanished");
    const blip = await open(theme, "manifestUnreadable");
    const goneBlock = gone.locator(".review").first();
    const blipBlock = blip.locator(".review").first();

    const goneSaid = flat(await goneBlock.innerText());
    const blipSaid = flat(await blipBlock.innerText());

    ok("manifest · a destroyed document says it has been destroyed", /destroyed/i.test(goneSaid), goneSaid.slice(0, 120));
    ok("manifest · and that waiting does not fix it", /Waiting does not fix it/.test(goneSaid), goneSaid.slice(0, 220));
    ok("manifest · and says where to put it back", /releases\/download\/channels/.test(goneSaid), goneSaid.slice(-160));
    ok("manifest · never tells somebody to wait for it", !/clears by itself|asks again/.test(goneSaid), goneSaid.slice(0, 220));

    ok("manifest · a failed read says it may clear by itself", /clears by itself/.test(blipSaid), blipSaid.slice(0, 200));
    ok("manifest · and does not say anything was destroyed", !/destroyed/i.test(blipSaid), blipSaid.slice(0, 200));

    const goneRule = await goneBlock.evaluate((n) => getComputedStyle(n).borderLeftColor);
    const blipRule = await blipBlock.evaluate((n) => getComputedStyle(n).borderLeftColor);
    ok("manifest · the two do not even wear the same rule", goneRule !== blipRule, `${goneRule} both`);

    const goneHead = (await goneBlock.locator("h3").innerText()).trim();
    const blipHead = (await blipBlock.locator("h3").innerText()).trim();
    ok("manifest · nor the same heading", goneHead !== blipHead, `${goneHead} both`);

    await gone.close();
    await blip.close();
  }

  /* ── Nothing published yet is the bootstrap case, not a failure ──────── */
  {
    const page = await open(theme, "manifestAbsent");
    ok("manifest · absence draws no block at all", (await page.locator(".review").count()) === 0, "drew one");
    const said = flat(await page.locator("section.upd-sec").filter({ hasText: "Channel for this Firetower" }).innerText());
    ok("manifest · and says the installation follows the newest release", /follows the newest release/.test(said), said.slice(-200));
    await page.close();
  }

  /* ── Download progress still reports ─────────────────────────────────── */
  {
    const page = await open(theme, "downloading");
    const button = await page.locator('section[data-part="B"] .btn.primary').innerText();
    ok("progress · the button says how far it has got", /Downloading… \d+%/.test(button), button);
    await page.close();
  }
}

await browser.close();
console.log(failed ? `\n  ${failed} assertion(s) failed\n` : `\n  all assertions held · ${OUT}\n`);
process.exit(failed ? 1 : 0);
