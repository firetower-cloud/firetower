/**
 * The transcript's scroll contract, asserted against the running app.
 *
 *   node scripts/mock-server.mjs 4487 &
 *   pnpm dev --port 5387 &
 *   MOCK_PORT=4487 DEV_PORT=5387 node scripts/following.mjs
 *
 * `pinned.mjs` is the *measurement* — it reports what happens to `scrollTop`
 * and leaves the reading to a person. This is the *regression*: one line per
 * clause of the contract, each one pass or fail, and a non-zero exit if any
 * of them is not what was agreed. The two are deliberately separate. A number
 * that moves is worth looking at by hand; a rule that broke should fail a
 * build.
 *
 * ## The rules, as they are written
 *
 *   at the last line          follows new content
 *   scrolled up, any amount   lets go immediately, and nothing moves the
 *                             viewport again until it is asked to
 *   content arrives           stays exactly where it was put
 *   back at the very bottom   follows again — only there, not "near"
 *   the pill                  only while detached and past 240px, hidden
 *                             while ⌘F is up, absent when there is nothing
 *                             below the fold
 *   the pill, clicked         travels to the end and follows again, without
 *                             its own travel reading as a hand
 *
 * ## Two things it fakes, and says so
 *
 * **The stream.** The mock's conversation is a fixed list of events, so
 * content arriving is simulated by appending a tall node to the transcript's
 * body — which is the element `Chat.tsx` has a `ResizeObserver` on, so the
 * code path that moves the viewport is the real one. What is not exercised is
 * the fold in `api/conversation.ts`; nothing here claims it.
 *
 * **A page of history.** `older()` needs a cursor the mock does not serve, so
 * the prepend is simulated the same way, at the top. That is enough to assert
 * the thing this change could have broken — a prepend must not re-attach, and
 * the distance to the bottom must survive it — and not enough to call the
 * paging path tested.
 *
 * Run at `deviceScaleFactor: 2`, like every other harness here, so a
 * `page.mouse.wheel(0, -100)` arrives as `deltaY: -50` and scrolls 100 CSS
 * pixels. Every number below is CSS pixels of scroll applied.
 */
const MOCK = Number(process.env.MOCK_PORT ?? 4401);
const DEV = Number(process.env.DEV_PORT ?? 5273);
process.env.HERE ??= `http://localhost:${MOCK}`;
process.env.APP ??= `http://localhost:${DEV}`;

import { chromium } from "playwright-core";
const { attach, fresh } = await import("./states.mjs");

const REGISTRY = JSON.stringify([
  { url: `http://localhost:${MOCK}`, serverId: "o_1", org: "Acme", user: "kevin", token: "tok", addedAt: "2026-09-21T09:00:00Z" },
]);

/* ── The page, and the handful of things this asks of it ─────────────────── */

/** Installed before the app runs: who writes `scrollTop`, and when. */
function probe() {
  const p = { on: false, target: null, writes: [] };
  window.__follow = p;
  const own = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    enumerable: own.enumerable,
    get: own.get,
    set(to) {
      if (p.on && this === p.target) {
        const frame = ((new Error().stack ?? "").split("\n")[2] ?? "").trim();
        p.writes.push({ t: Number(performance.now().toFixed(1)), to: Math.round(to), by: /at (\w+)/.exec(frame)?.[1] ?? "?" });
      }
      own.set.call(this, to);
    },
  });

  /** The conversation's scroller: the pane the transcript's title is in. */
  p.find = () => document.querySelector("h1.text-display")?.closest(".overflow-y-auto") ?? null;
  /** The transcript's body — what the pin's `ResizeObserver` is watching. */
  p.body = () => p.find()?.querySelector(".mx-auto") ?? null;
  p.below = () => {
    const el = (p.target ??= p.find());
    return Math.round(el.scrollHeight - el.scrollTop - el.clientHeight);
  };
  p.top = () => Math.round((p.target ??= p.find()).scrollTop);
  p.room = () => {
    const el = (p.target ??= p.find());
    return el.scrollHeight - el.clientHeight;
  };
  /** Content arriving, where the observer can see it. */
  p.grow = (px, where = "end") => {
    const body = p.body();
    const pad = document.createElement("div");
    pad.dataset.grown = "";
    pad.style.height = `${px}px`;
    if (where === "end") body.append(pad);
    else body.prepend(pad);
  };
  p.start = () => {
    p.target ??= p.find();
    p.writes = [];
    p.on = true;
  };
  p.stop = () => {
    p.on = false;
    return p.writes;
  };
}

const below = (page) => page.evaluate(() => window.__follow.below());
const top = (page) => page.evaluate(() => window.__follow.top());
const grow = (page, px, where) => page.evaluate(([n, w]) => window.__follow.grow(n, w), [px, where]);
const start = (page) => page.evaluate(() => window.__follow.start());
const stop = (page) => page.evaluate(() => window.__follow.stop());
const pill = (page) => page.locator("button.jump");

/** A page in one of the scroll scenes, at the end of a transcript taller than it. */
async function open(scene, { reducedMotion = "no-preference" } = {}) {
  const page = await fresh("dark", { servers: REGISTRY, scene });
  page.on("pageerror", (e) => console.log("    pageerror:", String(e).slice(0, 200)));
  await page.emulateMedia({ reducedMotion });
  await page.addInitScript(probe);
  await page.goto(`${process.env.APP}/#/sessions/s_1`, { waitUntil: "networkidle" });
  await page.waitForSelector("h1.text-display");
  await page.waitForFunction(() => !!window.__follow.find(), null, { timeout: 15_000 });
  await page.waitForTimeout(1200);
  const box = await page.evaluate(() => {
    const { x, y, width, height } = window.__follow.find().getBoundingClientRect();
    return { x: x + width / 2, y: y + height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  return { page, box };
}

/** Upward ticks the browser applies whole, one per round trip. */
async function up(page, tick, ticks = 1) {
  for (let i = 0; i < ticks; i++) await page.mouse.wheel(0, -tick);
  await page.waitForTimeout(260);
}

/** Back to the end the way a person gets there: downhill, past it. */
async function rebottom(page) {
  await page.mouse.wheel(0, 9000);
  await page.waitForTimeout(300);
}

/* ── The tally ───────────────────────────────────────────────────────────── */

let failed = 0;
const near = (got, want, slack = 3) => Math.abs(got - want) <= slack;

function ok(label, pass, said) {
  if (!pass) failed++;
  console.log(`    ${pass ? "ok  " : "FAIL"}  ${label}${said ? ` — ${said}` : ""}`);
}

/* ── The clauses ─────────────────────────────────────────────────────────── */

const browser = await chromium.launch({ channel: "chrome" });
attach(browser);

console.log(`\n  mock ${MOCK} · dev ${DEV} · Chrome, dark, 1280×824\n`);

/* One notch, a slow train, and a stream that cannot move you — in each of the
   three states the scroller used to behave differently in. The question card
   is the state this was reported from: `UserInputRequested` leaves the turn
   open, so the pin ran for as long as the question sat there. */
for (const scene of ["scroll-idle", "scroll-working", "scroll-asking"]) {
  console.log(`  ${scene}`);
  const { page } = await open(scene);

  ok("opens at the end", near(await below(page), 0), `${await below(page)}px below`);

  await start(page);
  await up(page, 40);
  ok("one notch of 40px moves it, and it stays moved", near(await below(page), 40), `${await below(page)}px up`);
  ok("nothing wrote scrollTop while it was up", (await stop(page)).length === 0);

  await rebottom(page);
  await start(page);
  await up(page, 10, 30);
  const train = await below(page);
  ok("a train of 30 ticks of 10px moves about 300px", near(train, 300, 12), `${train}px up`);
  ok("no writes against the train", (await stop(page)).length === 0);

  /* Held under a stream: 1,200px of content arriving below somebody who is
     reading, over a second and a bit. The viewport may not move at all. */
  const held = await top(page);
  await start(page);
  for (let i = 0; i < 12; i++) {
    await grow(page, 100, "end");
    await page.waitForTimeout(100);
  }
  ok("content arriving below moves nothing", (await top(page)) === held, `${await top(page)} was ${held}`);
  ok("and the pin wrote nothing", (await stop(page)).length === 0);

  /* The stream is the other way the end gets away from a reader: 100px up
     and sitting still, a long turn leaves them far from it with no scroll
     event anywhere. The pill has to arrive for that too. */
  await rebottom(page);
  await up(page, 100);
  ok("no pill 100px up", (await pill(page).count()) === 0, `${await below(page)}px up`);
  await grow(page, 900, "end");
  await page.waitForTimeout(400);
  ok("but one once the agent has written past it", (await pill(page).count()) === 1, `${await below(page)}px up`);

  /* Still follows when you are watching: untouched at the end, the newest
     line stays visible. This is the no-regression half of the contract and
     the one a too-strict rule breaks. */
  await rebottom(page);
  await start(page);
  await grow(page, 600, "end");
  await page.waitForTimeout(400);
  ok("at the last line, it follows new content", near(await below(page), 0), `${await below(page)}px below`);
  ok("which is the pin doing it", (await stop(page)).length > 0);

  await page.close();
}

/* Taking hold again, and the one place it may happen. */
{
  console.log("\n  taking hold again");
  const { page } = await open("scroll-working");

  await up(page, 400);
  await page.mouse.wheel(0, 380);
  await page.waitForTimeout(300);
  const short = await below(page);
  await grow(page, 500, "end");
  await page.waitForTimeout(400);
  ok(
    "a few pixels short of the end does not re-follow",
    short > 2 && short < 40 && near(await below(page), short + 500, 6),
    `stopped ${short}px short, then 500px arrived and it stayed`,
  );

  await rebottom(page);
  await grow(page, 500, "end");
  await page.waitForTimeout(400);
  ok("the very bottom does", near(await below(page), 0), `${await below(page)}px below`);

  /* A reader going back up the transcript, two pixels at a time: the gesture
     that could not escape the old 80px band however long it ran. */
  await rebottom(page);
  await up(page, 2, 20);
  ok("twenty ticks of 2px get away", (await below(page)) > 20, `${await below(page)}px up`);

  await page.close();
}

/* The pill. */
{
  console.log("\n  the pill");
  const { page } = await open("scroll-asking");

  ok("absent at the end", (await pill(page).count()) === 0);
  await up(page, 200);
  ok("absent 200px up, which is still two flicks from home", (await pill(page).count()) === 0, `${await below(page)}px up`);
  await up(page, 200);
  await page.waitForTimeout(260);
  ok("there past 240px", (await pill(page).count()) === 1, `${await below(page)}px up`);
  ok("says one thing, and never a count", (await pill(page).innerText()).trim() === "Jump to latest");
  ok(
    "carries the ember mark while the agent waits on you",
    (await pill(page).locator(".ember-pulse").count()) === 1,
    "a question is on screen",
  );
  ok("and no keycap", !(await pill(page).innerText()).includes("⌘"));

  /* Over the notes bar, which does not move. Taking a note needs a selection
     in a turn, so this is the one gesture here that is somebody's mouse. */
  const notesBefore = await page.locator("button:has-text('Another agent…')").count();
  ok("the notes bar is not up yet", notesBefore === 0);

  /* ⌘F means "I am reading, not watching", and the pill argues with it. */
  await page.keyboard.press("Meta+f");
  await page.waitForTimeout(300);
  ok("gone while ⌘F is up", (await pill(page).count()) === 0);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  ok("back when the find bar closes", (await pill(page).count()) === 1);

  /* ⌘F, with the bar up. The per-frame pin already stood down for `finding`
     and still does; what is checked here is that the new rule does not fight
     the jump to a match either — the view goes where the find bar sends it
     and stays there. A match already on screen is deliberately left alone, so
     each term below is one from a different part of the transcript. */
  const wasAt = await top(page);
  await page.keyboard.press("Meta+f");
  await page.waitForTimeout(300);
  await page.keyboard.type("runbook");
  await page.waitForTimeout(700);
  const found = await top(page);
  ok("⌘F goes to a match", found !== wasAt, `${wasAt} → ${found}`);

  await start(page);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  const stepped = await top(page);
  await page.waitForTimeout(900);
  ok("and nothing pins the view away from it", (await top(page)) === stepped, `${stepped}, a second later ${await top(page)}`);
  ok("with no writes from the pin", !(await stop(page)).some((w) => w.by === "loop"));

  /* A second term, from the first exchange, which is a long way above the
     first one: the bar keeps working while it is open. */
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("rotated");
  await page.waitForTimeout(700);
  ok("and a new term moves again", (await top(page)) < stepped - 200, `${stepped} → ${await top(page)}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await rebottom(page);
  await up(page, 400);
  await page.waitForTimeout(260);

  /* The travel: driven by hand, over `--dur-native`, re-reading the end every
     frame — and its own writes must not read as a hand and detach it. */
  await up(page, 400);
  await page.waitForTimeout(260);
  await start(page);
  await pill(page).click();
  await page.waitForTimeout(600);
  const travel = await stop(page);
  const span = travel.length > 1 ? travel.at(-1).t - travel[0].t : 0;
  ok("clicking it lands at the end", near(await below(page), 0), `${await below(page)}px below`);
  ok("the pill goes with it", (await pill(page).count()) === 0);
  ok("the travel is animated, not a teleport", travel.length >= 4, `${travel.length} writes over ${Math.round(span)}ms`);
  ok("and over about --dur-native", span > 40 && span < 420, `${Math.round(span)}ms`);

  await start(page);
  await grow(page, 600, "end");
  await page.waitForTimeout(400);
  ok("and it follows again afterwards", near(await below(page), 0), `${await below(page)}px below`);
  ok("which is the pin, not the travel", (await stop(page)).some((w) => w.by === "loop"));

  await page.close();
}

/* The same travel, asked to hold still. */
{
  console.log("\n  reduced motion");
  const { page } = await open("scroll-working", { reducedMotion: "reduce" });
  await up(page, 400);
  await page.waitForTimeout(260);
  await start(page);
  await pill(page).click();
  await page.waitForTimeout(400);
  const writes = await stop(page);
  ok("the jump is one write and done", writes.length === 1, `${writes.length} writes`);
  ok("and it is at the end", near(await below(page), 0));
  await page.close();
}

/* The agent's dot, in the other state it has. */
{
  console.log("\n  while the agent is writing");
  const { page } = await open("scroll-working");
  await up(page, 400);
  await page.waitForTimeout(260);
  ok("the mark breathes in slate", (await pill(page).locator(".breathe").count()) === 1);
  ok("and not in ember", (await pill(page).locator(".ember-pulse").count()) === 0);
  await page.close();
}

/* Nothing at all when there is nothing above. The ordinary scene is a
   conversation of a dozen exchanges, which is a couple of hundred pixels
   taller than the pane it opens in — so the window is opened taller for this
   one clause rather than a scene invented for it. */
{
  console.log("\n  a transcript shorter than its pane");
  const { page } = await open("default");
  await page.setViewportSize({ width: 1280, height: 1240 });
  await page.waitForTimeout(600);
  const room = await page.evaluate(() => window.__follow.room());
  ok("nothing below the fold", room <= 1, `${Math.round(room)}px of travel`);
  await up(page, 400);
  ok("and no pill, whatever the wheel does", (await pill(page).count()) === 0);
  await page.close();
}

/* A page of history landing above a reader. Simulated — see the note at the
   top — but the clause it is protecting is this file's: a prepend must not
   re-attach, and the distance to the bottom is what keeps somebody's place. */
{
  console.log("\n  older history, above the fold");
  const { page } = await open("scroll-working");
  await up(page, 400);
  await page.waitForTimeout(260);
  const was = { below: await below(page), top: await top(page) };
  await start(page);
  await grow(page, 800, "start");
  await page.waitForTimeout(400);
  const writes = await stop(page);
  ok("the distance to the end is unchanged", near(await below(page), was.below, 4), `${await below(page)}px, was ${was.below}px`);
  ok("so the line being read stayed under the eye", (await top(page)) >= was.top, `${await top(page)}, was ${was.top}`);
  ok("and nothing re-attached", (await pill(page).count()) === 1 && !writes.some((w) => w.by === "loop"));
  await page.close();
}

await browser.close();

console.log(`\n  ${failed === 0 ? "the contract holds" : `${failed} clause${failed === 1 ? "" : "s"} of the contract failed`}\n`);
process.exit(failed === 0 ? 0 : 1);
