/**
 * ⌘F inside an artifact, against the real picker in a real browser.
 *
 * The search runs in the page rather than in the app — the frame is another
 * origin — so the piece worth checking is the runtime the control plane
 * injects (`crates/ft-server/src/preview/annotations.js`), and nothing under
 * `vitest` can run it: it wants a document, a layout, and a window around it
 * to talk to. So this stands up both halves on loopback — a page served with
 * the runtime the way `instrument()` serves it, and a panel that embeds it the
 * way `ArtifactTab` does — drives Chrome at them, and speaks the bridge's
 * protocol by hand. Exits non-zero when the page answers wrongly, which is the
 * thing to run after touching the runtime or the bridge.
 *
 *   node scripts/find-in-artifact.mjs
 *
 * `channel: "chrome"` on purpose, like `shoot.mjs`: the Chrome already on the
 * machine, so `playwright-core` is the whole of the dependency.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const RUNTIME = new URL("../../crates/ft-server/src/preview/annotations.js", import.meta.url);
const runtime = await readFile(RUNTIME, "utf8");

/** A loopback server on whatever port is free, answering with `handle`. */
function serve(handle) {
  return new Promise((resolve) => {
    const server = createServer(handle);
    server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

/* Known counts. "revenue" is on the page four times a person can see — the
   heading, the paragraph, inside a <strong>, and once far below the fold —
   and three times they cannot: in a style sheet, in a script, and in a hidden
   block. "zz" is there seven hundred times, which is past the cap. */
const VISIBLE = 4;
const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>Quarterly</title>
<style>.hidden{display:none} .spacer{height:3000px} /* revenue, in a style sheet */</style>
<script>var revenue = 1; /* revenue, in a script */</script>
</head><body>
<h1>Quarterly Revenue</h1>
<p>Revenue grew in every region. Net <strong>revenue</strong> was flat.</p>
<div class="hidden">hidden revenue</div>
<div class="spacer"></div>
<p id="far">Far below the fold: revenue in the footer.</p>
<p id="many">${"zz ".repeat(700)}</p>
</body></html>`;

// The panel is a page of its own, on an origin of its own, exactly as the
// desktop app is to an artifact. It speaks the bridge's half of the protocol
// and keeps every message that comes back where the test can read it.
const panel = (artifactOrigin) => `<!doctype html>
<html><body style="margin:0">
<iframe id="f" style="width:900px;height:600px;border:0"></iframe>
<script>
  const origin = ${JSON.stringify(artifactOrigin)};
  const channel = crypto.randomUUID();
  const frame = document.getElementById("f");
  const log = [];
  window.__ft = { log, tell: (m) => frame.contentWindow.postMessage({ source: "firetower-panel", channel, ...m }, origin) };
  const hello = () => frame.contentWindow.postMessage({ source: "firetower-panel", channel, type: "hello" }, origin);
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (e.origin !== origin || e.source !== frame.contentWindow || !d || d.source !== "firetower-picker") return;
    if (d.type === "available") { hello(); return; }
    if (d.channel !== channel) return;
    log.push(d);
  });
  frame.src = origin + "/#__firetower_ui=" + encodeURIComponent(location.origin);
  hello();
  setInterval(() => { if (!log.some((m) => m.type === "ready")) hello(); }, 500);
</script>
</body></html>`;

const ui = await serve((_, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(panel(artifact.origin)));
const artifact = await serve((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path === "/__firetower/annotations.js") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(runtime);
    return;
  }
  // The tag `instrument()` prepends into <head>, with an artifact version
  // rather than a port, and the app's origin as the interface to accept.
  const tag = `<script src="/__firetower/annotations.js" data-session="s_test" data-artifact="v_test" data-ui="${ui.origin}" defer></script>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page.replace("<head>", "<head>" + tag));
});

const browser = await chromium.launch({ channel: "chrome", headless: true });
const failures = [];
let passed = 0;
const ok = (what) => {
  passed += 1;
  console.log(`  ok  ${what}`);
};

try {
  const tab = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  tab.on("pageerror", (e) => failures.push(`page error: ${e.message}`));
  await tab.goto(ui.origin);

  /** Every message of `type` the panel has heard so far. */
  const heard = (type) => tab.evaluate((t) => window.__ft.log.filter((m) => m.type === t), type);
  /** Say something to the page. */
  const tell = (m) => tab.evaluate((m) => window.__ft.tell(m), m);
  /** The next message of `type` after the `n` already heard. */
  async function next(type, n, within = 3000) {
    const started = Date.now();
    while (Date.now() - started < within) {
      const all = await heard(type);
      if (all.length > n) return all[n];
      await tab.waitForTimeout(25);
    }
    throw new Error(`no ${type} within ${within}ms`);
  }
  const frame = () => tab.frames().find((f) => f.url().startsWith(artifact.origin));
  /** In the page: what the highlight registry holds, and where the lit one is. */
  const painted = () =>
    frame().evaluate(() => {
      const all = CSS.highlights.get("__firetower-find");
      const on = CSS.highlights.get("__firetower-find-on");
      const spot = on ? [...on][0].getBoundingClientRect() : null;
      return {
        all: all ? all.size : 0,
        on: on ? on.size : 0,
        inView: spot ? spot.top >= 0 && spot.bottom <= innerHeight : null,
        styled: !!document.querySelector("head > style:last-of-type")?.textContent.includes("::highlight(__firetower-find)"),
        scrollY,
      };
    });

  const ready = await next("ready", 0, 10_000);
  assert.equal(ready.artifact, "v_test");
  assert.equal(ready.find, true, "ready says the page can be searched");
  ok("the page connects and says it finds");

  let founds = 0;
  await tell({ type: "find", query: "revenue" });
  let found = await next("found", founds++);
  assert.deepEqual(found, { source: "firetower-picker", channel: found.channel, type: "found", count: VISIBLE, at: 0 });
  let paint = await painted();
  assert.equal(paint.all, VISIBLE, "every visible match is painted");
  assert.equal(paint.on, 1, "one of them is lit");
  assert.ok(paint.styled, "the highlight style went into the document");
  assert.equal(paint.scrollY, 0, "the first match is in view already, so nothing scrolled");
  ok(`finds the ${VISIBLE} visible occurrences and none in a script, a style or a hidden block`);

  await tell({ type: "find", query: "REVENUE" });
  found = await next("found", founds++);
  assert.equal(found.count, VISIBLE);
  ok("ignores case");

  await tell({ type: "find-step", by: -1 });
  found = await next("found", founds++);
  assert.equal(found.at, VISIBLE - 1, "stepping back from the first wraps to the last");
  paint = await painted();
  assert.ok(paint.scrollY > 0, "the page scrolled to reach the match below the fold");
  assert.equal(paint.inView, true, "and the lit match is on screen");
  ok("steps and wraps, and brings the match into view");

  await tell({ type: "find-step", by: 1 });
  found = await next("found", founds++);
  assert.equal(found.at, 0, "stepping forward from the last wraps to the first");
  ok("wraps the other way");

  // Back to the far one, scroll away from it by hand, then let the page
  // change under the search. The count follows; the view does not.
  await tell({ type: "find-step", by: -1 });
  await next("found", founds++);
  await frame().evaluate(() => scrollTo(0, 0));
  await frame().evaluate(() => {
    const p = document.createElement("p");
    p.textContent = "A paragraph the page added later, with revenue in it.";
    document.body.append(p);
  });
  found = await next("found", founds++, 2000);
  assert.equal(found.count, VISIBLE + 1, "a match the page added is counted once the writing settles");
  assert.equal(found.at, VISIBLE - 1, "without losing your place");
  paint = await painted();
  assert.equal(paint.scrollY, 0, "and without moving the page — only a key you pressed does that");
  ok("follows a page that is still changing, and leaves the scroll alone");

  await tell({ type: "find", query: "zz" });
  found = await next("found", founds++);
  assert.equal(found.count, 600, "the count stops at the cap");
  ok("stops at 600");

  await tell({ type: "find", query: "nothing of the sort" });
  found = await next("found", founds++);
  assert.deepEqual([found.count, found.at], [0, 0]);
  paint = await painted();
  assert.equal(paint.all + paint.on, 0, "nothing is painted for a query that is not there");
  ok("says none, and paints nothing");

  // ⌘F and esc pressed *inside* the page, where the app cannot hear them.
  await tell({ type: "find", query: "revenue" });
  await next("found", founds++);
  await frame().locator("h1").click();
  const bars = (await heard("find-bar")).length;
  await tab.keyboard.press(process.platform === "darwin" ? "Meta+f" : "Control+f");
  let bar = await next("find-bar", bars);
  assert.equal(bar.open, true, "⌘F in the page asks for the bar");
  await tab.keyboard.press("Escape");
  bar = await next("find-bar", bars + 1);
  assert.equal(bar.open, false, "esc in the page, with a search painted, asks it closed");
  ok("hands ⌘F and esc from inside the page to the panel");

  await tell({ type: "find", query: "" });
  found = await next("found", founds++);
  assert.equal(found.count, 0);
  paint = await painted();
  assert.equal(paint.all + paint.on, 0, "closing the bar takes the highlights with it");
  // With no query there is nothing to watch: a change to the page must not
  // produce an answer nobody asked for.
  await frame().evaluate(() => document.body.append(document.createTextNode("revenue")));
  await tab.waitForTimeout(500);
  assert.equal((await heard("found")).length, founds, "and nothing answers a change once the search is closed");
  ok("clears, and stops watching");

  await frame().locator("h1").click();
  await tab.keyboard.press("Escape");
  await tab.waitForTimeout(200);
  assert.equal((await heard("find-bar")).length, bars + 2, "esc with nothing painted is the page's own");
  ok("leaves esc to the page when nothing is being searched");
} catch (e) {
  failures.push(e.stack ?? String(e));
} finally {
  await browser.close();
  ui.server.close();
  artifact.server.close();
}

if (failures.length > 0) {
  console.error(`\n  FAILED after ${passed} passed:\n`);
  for (const f of failures) console.error(f, "\n");
  process.exit(1);
}
console.log(`\n  ${passed} passed`);
