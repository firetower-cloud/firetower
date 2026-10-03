/**
 * When the app learns an edit happened, by two routes at once.
 *
 * The inspector polls `session_diff` every eight seconds. The conversation
 * socket already carries the same news the moment the agent reports it, as a
 * `FileChange` item — so this runs a mock that edits a file on the socket and
 * answers the diff, and prints both arrivals on one clock.
 *
 * What it shows is the gap: how long the pane spends drawing a diff it has
 * already been told is stale, and how many of the polls in between said
 * nothing new at all.
 *
 *   FT_MOCK_DIFF=4x400 FT_MOCK_DIFF_CHURN=1 FT_MOCK_EDITS=9000 \
 *     node scripts/mock-server.mjs 4471 &
 *   MOCK_PORT=4471 DEV_PORT=5374 node scripts/when.mjs
 */
import { chromium } from "playwright-core";

const MOCK = Number(process.env.MOCK_PORT ?? 4401);
const DEV = Number(process.env.DEV_PORT ?? 5273);
const SECONDS = Number(process.env.SECONDS ?? 45);

const REGISTRY = JSON.stringify([
  { url: `http://localhost:${MOCK}`, serverId: "o_1", org: "Acme", user: "kevin", token: "tok", addedAt: "2026-09-21T09:00:00Z" },
]);

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, colorScheme: "dark" });
page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 300)));
await page.addInitScript(([r]) => {
  window.localStorage.setItem("firetower.servers", r);
  window.localStorage.setItem("firetower.scope", "o_1");
}, [REGISTRY]);

/**
 * The socket, listened to from outside the app.
 *
 * Wrapping `WebSocket` rather than reading React's state: this is about *when*
 * a frame lands on the page, which is a fact about the connection and not about
 * what any component decided to do with it.
 */
await page.addInitScript(() => {
  window.__seen = [];
  const Real = window.WebSocket;
  window.WebSocket = new Proxy(Real, {
    construct(target, args) {
      const ws = new target(...args);
      ws.addEventListener("message", (e) => {
        try {
          const frame = JSON.parse(e.data);
          if (frame.t !== "line") return;
          for (const ev of frame.events ?? []) {
            if (ev.type === "ItemStarted" && ev.kind === "FileChange") {
              window.__seen.push({ what: "the socket says a file changed", at: performance.now() });
            }
          }
        } catch {
          /* not ours */
        }
      });
      return ws;
    },
  });
});

const at = [];
page.on("response", async (r) => {
  if (!r.url().includes("/diff")) return;
  const body = await r.body().catch(() => Buffer.alloc(0));
  at.push({ what: "a diff poll answered", ms: Date.now(), bytes: body.length, body: body.toString().slice(0, 4e6) });
});

const started = Date.now();
await page.goto(`http://localhost:${DEV}/#/sessions/w_1`, { waitUntil: "networkidle" });
await page.locator("[data-row]").first().waitFor({ timeout: 60_000 });

/* `TAB=file` reads a file instead of the conversation. The invalidation that
   turns an edit into a refresh lives in `Chat.tsx`, and the workbench unmounts
   the chat when another tab is up — so this is the same run with the one thing
   that listens for edits taken off the screen. */
if (process.env.TAB === "file") {
  await page.locator('[title="Open the whole file"]').first().click({ force: true });
  await page.waitForTimeout(1500);
  console.log(`(reading a file, not the conversation — the chat is unmounted)\n`);
}
await page.waitForTimeout(SECONDS * 1000);

const socketAt = await page.evaluate(() => window.__seen.map((s) => s.at));
const origin = await page.evaluate(() => performance.timeOrigin);

/* Both clocks onto one line, in seconds since the page opened. */
const events = [
  ...socketAt.map((ms) => ({ t: (origin + ms - started) / 1000, what: "socket: a file changed" })),
  ...at.map((p, i) => ({
    t: (p.ms - started) / 1000,
    what: `poll: ${(p.bytes / 1e6).toFixed(1)} MB${i > 0 && at[i - 1].body === p.body ? "  (identical to the one before — said nothing)" : ""}`,
  })),
].sort((a, b) => a.t - b.t);

console.log("  at      what");
for (const e of events) console.log(`${e.t.toFixed(1).padStart(5)}s   ${e.what}`);

const polls = at.length;
const same = at.filter((p, i) => i > 0 && at[i - 1].body === p.body).length;
const pulled = at.reduce((n, p) => n + p.bytes, 0);
console.log(
  `\n${SECONDS}s: ${socketAt.length} edits reported on the socket, ${polls} diff polls (${(pulled / 1e6).toFixed(1)} MB), ` +
    `${same} of which returned exactly what the one before did.`,
);

await browser.close();
