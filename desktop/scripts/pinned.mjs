/**
 * "It's like if it's somehow magneted to the bottom" — measured.
 *
 *   node scripts/mock-server.mjs 4487 &
 *   pnpm dev --port 5387 &
 *   MOCK_PORT=4487 DEV_PORT=5387 node scripts/pinned.mjs
 *
 * Nothing here fixes anything. It drives the real conversation in real Chrome
 * and reports what happens to `scrollTop` when somebody scrolls up, because
 * "it stutters" is not a number and the fix will be argued over numbers.
 *
 * ## What it measures
 *
 *   1. the tick-by-tick series — where each upward wheel event put the
 *      scroller, and where the next animation frame put it back
 *   2. the escape threshold — the smallest single wheel delta that gets away,
 *      and whether a burst of small ones ever does
 *   3. the same gesture in the three states `Chat.tsx` behaves differently in:
 *      the turn finished, the turn open, and the turn open with a question
 *      nobody has answered
 *   4. whether a trackpad's flick — a train of small deltas, which is what
 *      momentum actually is — gets anywhere, against the same gesture sent as
 *      one large event
 *   5. how often `scrollTop` is written programmatically, per second, at rest
 *      and while somebody is scrolling against it
 *
 * ## How it attributes a write
 *
 * `Element.prototype.scrollTop`'s setter is wrapped, so every programmatic
 * write to *this one element* is logged with the stack frame that made it. In
 * a dev build those frames are named, which is the whole reason this is run
 * against `pnpm dev` rather than a build: `loop` is the per-frame pin,
 * `toEnd` is the resize observer, and anything else is one of the layout
 * effects. The line numbers in a stack are Vite's transformed ones and sit a
 * few lines off the source — the names are what identify the writer.
 *
 * `requestAnimationFrame` is wrapped for the same reason: a loop that is
 * running but has nothing to do writes nothing, so counting writes alone
 * cannot tell a live loop from a dead one. Counting the frames each caller
 * actually ran can.
 *
 * Both wrappers delegate; neither changes what the app does.
 *
 * ## The unit
 *
 * Every number here is CSS pixels of scroll *applied*, which is the unit
 * `Chat.tsx`'s `< 80` is in. It is not the wheel event's own `deltaY`: the
 * harness runs at `deviceScaleFactor: 2` — as every screenshot here does — and
 * at that factor a `page.mouse.wheel(0, -100)` arrives as `deltaY: -50` while
 * scrolling 100 CSS pixels. The applied scroll is what is asked for and what
 * is reported; the raw `deltaY` is kept in the JSON and used for nothing.
 */
const MOCK = Number(process.env.MOCK_PORT ?? 4401);
const DEV = Number(process.env.DEV_PORT ?? 5273);
/**
 * Run it again with Chrome's wheel animation on: `SMOOTH=1`.
 *
 * It was expected to matter and it does not. A wheel event dispatched over CDP
 * lands whole, in one frame, with the flag either way — measured, both runs
 * identical to the pixel — so Chrome's animation is on a path a synthetic
 * event does not take. The knob is kept because that is worth being able to
 * re-check rather than remember, and because its *not* mattering is the reason
 * the numbers below are per-frame rather than per-event.
 *
 * Which leaves one thing this harness cannot answer: the app ships in
 * WKWebView, and whether WebKit spreads one physical gesture across frames
 * differently is not measurable from here. The per-frame rule is the finding;
 * how many pixels a real device puts in a frame is not.
 */
const SMOOTH = process.env.SMOOTH === "1";
/* Set before `states.mjs` is imported, because it reads these at import. This
   machine is shared and 4401 is as often somebody else's as it is free, so the
   ports have to be arguments — hence the dynamic import below. */
process.env.HERE ??= `http://localhost:${MOCK}`;
process.env.APP ??= `http://localhost:${DEV}`;

import { chromium } from "playwright-core";
const { attach, fresh } = await import("./states.mjs");

/* One server and no second one. The shots live with an unreachable `o_2`
   because a screenshot does not care about its retry traffic; a measurement
   taken at frame resolution does. */
const REGISTRY = JSON.stringify([
  { url: `http://localhost:${MOCK}`, serverId: "o_1", org: "Acme", user: "kevin", token: "tok", addedAt: "2026-09-21T09:00:00Z" },
]);

/* The three states, named as the mock's scenes. */
const STATES = {
  idle: "the turn finished",
  working: "the turn is open",
  asking: "the turn is open, with a question unanswered",
};

/* ── The probe, installed before anything of the app runs ────────────────── */

function probe() {
  const p = {
    /* Off until a measurement starts, so the hooks cost nothing while the
       page is still assembling itself. */
    on: false,
    target: null,
    log: [],
    /* Frames run, by whoever registered the callback. */
    frames: {},
  };
  window.__pinned = p;

  const r = (n) => (n === null || n === undefined ? n : Math.round(n));
  /** A stack line, as a name and a file. */
  const who = (line) => {
    const m = /at ([^ (]+) \(.*\/([^/?]+)(?:\?[^:]*)?:(\d+):\d+\)/.exec(line ?? "");
    if (m) return `${m[1]} @ ${m[2]}:${m[3]}`;
    const anon = /at .*\/([^/?]+)(?:\?[^:]*)?:(\d+):\d+/.exec(line ?? "");
    return anon ? `(anonymous) @ ${anon[1]}:${anon[2]}` : (line ?? "").trim().slice(0, 90);
  };
  /**
   * Whoever called the wrapper.
   *
   * `Error`, this function, the wrapper itself, then the caller — so three.
   * The wrappers are installed by `addInitScript` and have no URL of their
   * own, which is how a wrong depth announces itself: `<anonymous>`.
   */
  const caller = () => who((new Error().stack ?? "").split("\n")[3]);

  const note = (kind, extra) => {
    const el = p.target;
    p.log.push({
      t: Number(performance.now().toFixed(2)),
      kind,
      top: el ? r(el.scrollTop) : null,
      height: el ? r(el.scrollHeight) : null,
      view: el ? r(el.clientHeight) : null,
      ...extra,
    });
  };
  p.note = (label) => p.on && note("mark", { label });

  /* Every programmatic write to the scroller, with who made it. */
  const own = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    enumerable: own.enumerable,
    get: own.get,
    set(to) {
      if (p.on && this === p.target) {
        const from = r(own.get.call(this));
        note("write", { from, to: r(to), by: caller() });
      }
      own.set.call(this, to);
    },
  });

  /* Frames actually run, by caller. A pin that is running and satisfied writes
     nothing, and this is the only thing that can see it. */
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => {
    const by = p.on ? caller() : null;
    return raf((t) => {
      if (by) p.frames[by] = (p.frames[by] ?? 0) + 1;
      return cb(t);
    });
  };

  /** The conversation's scroller: the pane the transcript's title is in. */
  p.find = () => document.querySelector("h1.text-display")?.closest(".overflow-y-auto") ?? null;

  /**
   * Watch an element.
   *
   * The frame sampler is registered here, which is after the app's own pin —
   * callbacks run in registration order and each re-registers itself at the
   * end, so that order holds for every later frame too. So a `frame` row is
   * always *after* the pin has had its say in that frame, which is exactly the
   * reading "and what did the next frame make of it" wants.
   */
  p.watch = (el) => {
    p.target = el;
    el.addEventListener("scroll", () => p.on && note("scroll"), { passive: true });
    el.addEventListener("wheel", (e) => p.on && note("wheel", { dy: r(e.deltaY) }), { passive: true, capture: true });
    const sample = () => {
      if (p.on) note("frame");
      raf(sample);
    };
    raf(sample);
    return el.className;
  };

  p.start = () => {
    p.log = [];
    p.frames = {};
    p.on = true;
  };
  p.stop = () => {
    p.on = false;
    return { log: p.log, frames: p.frames };
  };
  /** How far the content runs on below the viewport. 0 is pinned. */
  p.below = () => (p.target ? r(p.target.scrollHeight - p.target.scrollTop - p.target.clientHeight) : null);
}

/* ── Driving it ──────────────────────────────────────────────────────────── */

const browser = await chromium.launch({
  channel: "chrome",
  args: SMOOTH ? ["--enable-smooth-scrolling"] : ["--disable-smooth-scrolling"],
});
attach(browser);

/** A page in one of the three states, scrolled to the end and instrumented. */
async function open(state) {
  const page = await fresh("dark", { servers: REGISTRY, scene: `scroll-${state}` });
  page.on("pageerror", (e) => console.log("    pageerror:", String(e).slice(0, 200)));
  await page.addInitScript(probe);
  await page.goto(`${process.env.APP}/#/sessions/s_1`, { waitUntil: "networkidle" });
  await page.waitForSelector("h1.text-display");
  /* The transcript has to be taller than the pane before any of this means
     anything, and markdown settles a frame or two after the items land. */
  await page.waitForFunction(
    () => {
      const el = window.__pinned.find();
      return !!el && el.scrollHeight - el.clientHeight > 1200;
    },
    null,
    { timeout: 15_000 },
  );
  await page.waitForTimeout(1200);
  const seen = await page.evaluate(() => {
    const el = window.__pinned.find();
    return { className: window.__pinned.watch(el), below: window.__pinned.below(), height: el.scrollHeight, view: el.clientHeight };
  });
  if (!seen.className.includes("scroll-slim")) throw new Error(`that is not the conversation's scroller: ${seen.className}`);
  const box = await page.evaluate(() => {
    const { x, y, width, height } = window.__pinned.find().getBoundingClientRect();
    return { x: x + width / 2, y: y + height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  /* A channel of its own, for the one thing `page.mouse.wheel` cannot do: send
     the next event without waiting for the last one to be acknowledged. The
     round trip is ~33ms, which is two animation frames — so everything driven
     through `page.mouse` is, unavoidably, a gesture with a frame of quiet
     after every event. A trackpad has none. See `packed`. */
  const cdp = await page.context().newCDPSession(page);
  return { page, seen, box, cdp };
}

/**
 * Ticks with nothing between them.
 *
 * Sent down one websocket in order and not awaited one at a time, so several
 * land inside a single frame — which is what a trackpad at ~8ms does and what
 * `page.mouse.wheel` cannot reproduce. This is the other half of the contrast
 * the measurement is for: the same total delta, delivered at two cadences.
 */
const packedUp = (cdp, box, tick, n) =>
  Promise.all(
    Array.from({ length: n }, () =>
      cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: -tick, modifiers: 0 }),
    ),
  );

/** Back to the bottom, the way a person gets there: downhill. */
async function rebottom(page) {
  await page.mouse.wheel(0, 6000);
  await page.waitForTimeout(250);
  return page.evaluate(() => window.__pinned.below());
}

/** Upward ticks, as fast as the channel will carry them. */
async function up(page, { tick, ticks, gap = 0 }) {
  for (let i = 0; i < ticks; i++) {
    await page.mouse.wheel(0, -tick);
    if (gap) await page.waitForTimeout(gap);
  }
}

const below = (page) => page.evaluate(() => window.__pinned.below());
const start = (page) => page.evaluate(() => window.__pinned.start());
const stop = (page) => page.evaluate(() => window.__pinned.stop());
const mark = (page, label) => page.evaluate((l) => window.__pinned.note(l), label);

/* ── 1. The tick-by-tick series ──────────────────────────────────────────── */

/**
 * One tick, then two frames to see what became of it. Ten of them.
 *
 * Run twice, at two tick sizes, because the two sizes are the finding: a tick
 * is 100px when it comes off a wheel's notch and a few pixels when it comes
 * off a trackpad, and only one of those gets anywhere.
 */
async function series(page, { tick, ticks = 10, gap = 48 }) {
  await rebottom(page);
  await start(page);
  await up(page, { tick, ticks, gap });
  await page.waitForTimeout(300);
  return { tick, gap, ...(await stop(page)), kept: await below(page) };
}

/* ── 2. The escape threshold ─────────────────────────────────────────────── */

/** The smallest single wheel delta that is still off the bottom 400ms later. */
async function threshold(page) {
  const tried = [];
  for (const dy of [20, 40, 60, 70, 78, 80, 82, 100, 120, 200, 500, 1200]) {
    const from = await rebottom(page);
    await start(page);
    await page.mouse.wheel(0, -dy);
    await page.waitForTimeout(400);
    const { log } = await stop(page);
    const far = Math.max(0, ...log.filter((e) => e.top !== null).map((e) => e.height - e.top - e.view));
    tried.push({ dy, from, reached: far, kept: await below(page), writes: log.filter((e) => e.kind === "write").length });
  }
  return tried;
}

/** Whether a burst of forty small ticks ever gets away, by tick size. */
async function burst(page) {
  const tried = [];
  for (const tick of [5, 10, 20, 40, 60, 79, 80, 100]) {
    await rebottom(page);
    await start(page);
    await up(page, { tick, ticks: 40 });
    await page.waitForTimeout(300);
    const { log } = await stop(page);
    const wheels = log.filter((e) => e.kind === "wheel");
    const spacing = wheels.length > 1 ? (wheels.at(-1).t - wheels[0].t) / (wheels.length - 1) : null;
    const far = Math.max(0, ...log.filter((e) => e.top !== null).map((e) => e.height - e.top - e.view));
    tried.push({
      tick,
      ticks: wheels.length,
      asked: tick * 40,
      everyMs: spacing === null ? null : Number(spacing.toFixed(1)),
      reached: far,
      kept: await below(page),
      writes: log.filter((e) => e.kind === "write").length,
    });
  }
  return tried;
}

/**
 * A sustained train, at a controlled number of events per frame.
 *
 * The one measurement that explains "sometimes". What decides whether a
 * gesture escapes is not how much delta it carries, nor how many events it is
 * made of, but **how many pixels arrive between two animation frames** —
 * because a frame is where the pin gets its turn and it undoes everything
 * since the last one.
 *
 * So the tick is held at 10px, which is a finger moving unhurriedly on glass,
 * and what varies is how many of them land in one frame. A trackpad at ~8ms
 * delivers two; a fast one more.
 */
async function train(page, cdp, box, { tick = 10, frames = 30 } = {}) {
  const tried = [];
  for (const perFrame of [1, 2, 4, 6, 7, 8, 9, 12]) {
    await rebottom(page);
    await start(page);
    for (let f = 0; f < frames; f++) {
      await packedUp(cdp, box, tick, perFrame);
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(300);
    const { log } = await stop(page);
    const far = Math.max(0, ...log.filter((e) => e.top !== null).map((e) => e.height - e.top - e.view));
    tried.push({
      perFrame,
      px: tick * perFrame,
      asked: tick * perFrame * frames,
      reached: far,
      kept: await below(page),
      writes: log.filter((e) => e.kind === "write").length,
      ticks: log.filter((e) => e.kind === "wheel").length,
    });
  }
  return { tick, frames, tried };
}

/* ── 3. A flick, and the momentum after it ───────────────────────────────── */

/**
 * What a trackpad actually sends.
 *
 * Not one event. A flick on a Mac is a train: a few pixels while the fingers
 * are still accelerating, a peak in the middle, and a long decaying tail that
 * carries most of the distance after the fingers have left the glass. So the
 * question "does momentum survive" is the question "does a train of deltas,
 * none of them large, get anywhere" — and `page.mouse.wheel` applies each
 * event whole, which means every pixel in this train is one the browser
 * genuinely tried to scroll.
 */
const TRAIN = [4, 9, 16, 26, 38, 52, 64, 70, 66, 58, 49, 41, 34, 28, 23, 19, 15, 12, 10, 8, 6, 5, 4, 3, 2, 2, 1, 1];

async function inertia(page, cdp, box) {
  await rebottom(page);
  await start(page);
  /* Two per frame, because ~8ms into a 16.7ms frame is two. */
  for (let i = 0; i < TRAIN.length; i += 2) {
    const pair = TRAIN.slice(i, i + 2);
    await Promise.all(pair.map((dy) => packedUp(cdp, box, dy, 1)));
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(400);
  const { log } = await stop(page);
  const far = Math.max(0, ...log.filter((e) => e.top !== null).map((e) => e.height - e.top - e.view));
  /* Which frame, if any, got through: the first write whose `from` is more
     than the 80px band below the bottom is the frame the pin lost. */
  const broke = log.find((e) => e.top !== null && e.kind !== "write" && e.height - e.top - e.view >= 80);
  return {
    asked: TRAIN.reduce((a, b) => a + b, 0),
    peak: Math.max(...TRAIN),
    perFramePeak: Math.max(...TRAIN.map((_, i) => (i % 2 ? 0 : (TRAIN[i] ?? 0) + (TRAIN[i + 1] ?? 0)))),
    reached: far,
    kept: await below(page),
    writes: log.filter((e) => e.kind === "write").length,
    brokeAt: broke ? Number((broke.t - log[0].t).toFixed(0)) : null,
    log,
  };
}

/** One event carrying the whole gesture, for contrast. */
async function flick(page, dy = 1200) {
  await rebottom(page);
  await start(page);
  await page.mouse.wheel(0, -dy);
  await page.waitForTimeout(600);
  const { log } = await stop(page);
  return { log, kept: await below(page) };
}

/* ── 4. Writes per second ────────────────────────────────────────────────── */

/** At rest, and while being scrolled against. */
async function rate(page, cdp, box, seconds = 3) {
  await rebottom(page);
  await start(page);
  const since = await page.evaluate(() => Math.round(performance.now()));
  await page.waitForTimeout(seconds * 1000);
  const idle = await stop(page);

  /* Four 10px ticks a frame — 40px, which is under the band, so this is the
     trapped case and the pin has something to undo on every single frame. */
  await rebottom(page);
  await start(page);
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    await packedUp(cdp, box, 10, 4);
    await page.waitForTimeout(16);
  }
  const fought = await stop(page);

  return { seconds, since, idle, fought, kept: await below(page) };
}

/* ── Reporting ───────────────────────────────────────────────────────────── */

const pad = (s, n) => String(s).padStart(n);
const per = (n, seconds) => (n / seconds).toFixed(1);

/**
 * Each wheel event, what the browser did with it, and what undid it.
 *
 * `was` comes off the row *before* the wheel rather than off the wheel row,
 * because Chrome's compositor applies a scroll before it dispatches the event
 * to the main thread — so by the time a listener runs, `scrollTop` has already
 * moved and the wheel row reads the position *after* its own effect.
 */
function ticks(log) {
  const out = [];
  let last = null;
  for (let i = 0; i < log.length; i++) {
    const e = log[i];
    if (e.kind !== "wheel") {
      if (e.top !== null) last = e.kind === "write" ? null : e.top;
      continue;
    }
    const after = log.slice(i + 1);
    const end = after.findIndex((x) => x.kind === "wheel");
    const span = end === -1 ? after : after.slice(0, end);
    const moved = span.filter((x) => x.kind === "scroll");
    const writes = span.filter((x) => x.kind === "write");
    const frames = span.filter((x) => x.kind === "frame");
    const to = moved.length ? Math.min(e.top, ...moved.map((x) => x.top)) : e.top;
    out.push({
      at: e.t,
      was: last,
      to,
      moved: last === null ? null : last - to,
      writes: writes.length,
      read: writes.length ? writes[0].from : null,
      wrote: writes.length ? writes[0].to : null,
      backIn: writes.length ? Number((writes[0].t - e.t).toFixed(1)) : null,
      by: writes.length ? writes.at(-1).by : null,
      landed: frames.length ? frames.at(-1).top : null,
      bottom: e.height - e.view,
    });
    last = to;
  }
  return out;
}

const tally = (log) => {
  const by = {};
  for (const e of log) if (e.kind === "write") by[e.by] = (by[e.by] ?? 0) + 1;
  return by;
};

const writers = (log, indent = "      ") => {
  const by = tally(log);
  if (!Object.keys(by).length) return console.log(`${indent}nothing wrote scrollTop`);
  for (const [who, n] of Object.entries(by).sort((a, b) => b[1] - a[1])) console.log(`${indent}${pad(n, 5)}×  ${who}`);
};

const runners = (frames, indent = "      ") => {
  const rows = Object.entries(frames).sort((a, b) => b[1] - a[1]);
  if (!rows.length) return console.log(`${indent}nothing asked for a frame`);
  for (const [who, n] of rows) console.log(`${indent}${pad(n, 5)}×  ${who}`);
};

function tickTable(s) {
  const rows = ticks(s.log);
  console.log(`\n  ${rows.length} upward ticks of ${s.tick}px, ${s.gap}ms apart`);
  console.log("    tick   at(ms)    was    wheel put it   moved   the pin read   and wrote   back in   landed");
  for (const [i, t] of rows.entries())
    console.log(
      `    ${pad(i + 1, 4)}   ${pad(t.at.toFixed(0), 6)}   ${pad(t.was ?? "—", 4)}   ${pad(t.to, 12)}   ${pad(t.moved ?? "—", 5)}   ${pad(t.read ?? "—", 12)}   ${pad(t.wrote ?? "—", 9)}   ${pad(t.backIn === null ? "—" : `${t.backIn}ms`, 7)}   ${pad(t.landed ?? "—", 6)}`,
    );
  console.log(`    the bottom is scrollTop ${rows[0]?.bottom ?? "?"}; ended ${s.kept}px above it`);
  writers(s.log, "    written by: ");
}

console.log(`\n  mock ${MOCK} · dev ${DEV} · Chrome${SMOOTH ? " with --enable-smooth-scrolling" : ""}, dark, 1280×824`);

const report = { smooth: !!SMOOTH };
for (const [state, what] of Object.entries(STATES)) {
  console.log(`\n${"═".repeat(78)}\n  ${state} — ${what}\n${"═".repeat(78)}`);
  const { page, seen, box, cdp } = await open(state);
  console.log(`  ${seen.height}px of transcript in a ${seen.view}px pane, ${seen.below}px below the fold`);

  /* 1 — the series, at a trackpad's tick size and a wheel notch's. */
  const small = await series(page, { tick: 40 });
  tickTable(small);
  const notch = await series(page, { tick: 100 });
  tickTable(notch);
  console.log("    frames run while that was going on, by whoever asked for them:");
  runners(notch.frames);

  /* 2 */
  const t = await threshold(page);
  console.log("\n  One wheel event, how big it has to be");
  console.log("    delta   reached   kept   writes");
  for (const r of t) console.log(`    ${pad(r.dy, 5)}   ${pad(r.reached, 7)}   ${pad(r.kept, 4)}   ${pad(r.writes, 6)}`);
  const escaped = t.find((r) => r.kept > 2);
  console.log(`    smallest that got away: ${escaped ? `${escaped.dy}px` : "none of them"}`);

  const b = await burst(page);
  console.log("\n  Forty ticks in a row, one at a time — a frame of quiet after each");
  console.log("    tick   asked for   every   furthest   kept   writes");
  for (const r of b)
    console.log(`    ${pad(r.tick, 4)}   ${pad(r.asked, 9)}   ${pad(`${r.everyMs}ms`, 7)}   ${pad(r.reached, 8)}   ${pad(r.kept, 4)}   ${pad(r.writes, 6)}`);

  const k = await train(page, cdp, box);
  console.log(`\n  A sustained train of ${k.tick}px ticks over ${k.frames} frames, by how many land in one frame`);
  console.log("    per frame   px a frame   asked for   furthest   kept   writes   per frame");
  for (const r of k.tried)
    console.log(
      `    ${pad(r.perFrame, 9)}   ${pad(r.px, 10)}   ${pad(r.asked, 9)}   ${pad(r.reached, 8)}   ${pad(r.kept, 4)}   ${pad(r.writes, 6)}   ${pad((r.writes / k.frames).toFixed(2), 9)}`,
    );
  const through = k.tried.find((r) => r.kept > 2);
  console.log(`    gets through at ${through ? `${through.px}px a frame (${through.perFrame} ticks)` : "no rate tried"}`);

  /* 3 */
  const i = await inertia(page, cdp, box);
  console.log(`\n  A trackpad flick: ${TRAIN.length} events, ${i.asked}px in total, two a frame`);
  console.log(`    ${i.peak}px at the biggest event, ${i.perFramePeak}px in the biggest frame`);
  console.log(`    furthest ${i.reached}px · kept ${i.kept}px · ${i.writes} writes · ${i.brokeAt === null ? "never cleared the band" : `cleared the band ${i.brokeAt}ms in`}`);
  const f = await flick(page);
  console.log("\n  The same 1200px as one event, frame by frame");
  console.log("    t(ms)   what     scrollTop    below   by");
  const seq = f.log.filter((e) => e.kind !== "mark").slice(0, 24);
  const t0 = seq[0]?.t ?? 0;
  for (const e of seq)
    console.log(
      `    ${pad((e.t - t0).toFixed(1), 5)}   ${String(e.kind).padEnd(7)}  ${pad(e.kind === "write" ? `${e.from}→${e.to}` : e.top, 10)}   ${pad(e.height - (e.kind === "write" ? e.to : e.top) - e.view, 6)}   ${e.by ?? ""}`,
    );
  console.log(`    kept ${f.kept}px off the bottom`);

  /* 4 */
  const w = await rate(page, cdp, box);
  console.log(`\n  Writes to scrollTop per second, over ${w.seconds}s, ${(w.since / 1000).toFixed(1)}s after the page loaded`);
  const show = (label, got) => {
    const n = got.log.filter((e) => e.kind === "write").length;
    /* Against how often the gesture actually moved it: the pin can only undo a
       frame in which something moved, so this is the ceiling it is working
       against and not a property of the pin. */
    const moved = got.log.filter((e) => e.kind === "scroll").length;
    console.log(
      `    ${label.padEnd(20)} ${pad(n, 5)} writes  ${pad(per(n, w.seconds), 6)}/s   against ${pad(moved, 4)} scrolls  ${pad(per(moved, w.seconds), 6)}/s`,
    );
    writers(got.log);
    console.log("      frames:");
    runners(got.frames, "        ");
  };
  show("at rest", w.idle);
  show("scrolled against", w.fought);

  report[state] = { seen, small, notch, threshold: t, burst: b, packed: k, inertia: i, flick: f, rate: w };
  await page.close();
}

await browser.close();

if (process.env.OUT) {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(process.env.OUT, { recursive: true });
  const to = `${process.env.OUT}/pinned${SMOOTH ? "-smooth" : ""}.json`;
  writeFileSync(to, JSON.stringify(report, null, 2));
  console.log(`\n  raw log → ${to}`);
}
console.log("");
