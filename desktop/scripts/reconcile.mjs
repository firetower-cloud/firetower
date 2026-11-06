/**
 * The drawing beside the build, one sheet per state, both themes on it.
 *
 *   pnpm shoot:proto && pnpm shoot:app && pnpm reconcile
 *
 * Four panes: the prototype and the app in light along the top, the same two
 * in dark underneath. One image per state is the unit that can actually be
 * *compared* — a contact sheet of ninety-six thumbnails tells you a screen
 * exists and nothing about whether it matches.
 *
 * Where the app could not be driven into the state, its pane says so with the
 * reason, because a blank is indistinguishable from a pass.
 */
import { chromium } from "playwright-core";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

const ROOT = new URL("../../.firetower/reconcile/", import.meta.url).pathname;
const OUT = `${ROOT}pairs`;
mkdirSync(OUT, { recursive: true });

const states = JSON.parse(readFileSync(`${ROOT}proto/index.json`, "utf8"));
const app = new Map(JSON.parse(readFileSync(`${ROOT}app/index.json`, "utf8")).map((r) => [r.id, r]));

const PANE = 620;
const css = `
  *{box-sizing:border-box;margin:0}
  body{font:13px/1.4 -apple-system,system-ui,sans-serif;background:#8a8a8a;padding:14px;width:${PANE * 2 + 42}px}
  h1{font-size:15px;font-weight:600;color:#fff;margin-bottom:2px}
  .sub{font-size:12px;color:#e8e8e8;margin-bottom:10px}
  .grid{display:grid;grid-template-columns:${PANE}px ${PANE}px;gap:8px 10px}
  .cap{font-size:11px;font-weight:600;color:#fff;letter-spacing:.02em}
  figure{margin:0}
  img{width:${PANE}px;display:block;border-radius:4px}
  .gap{height:6px;grid-column:1/-1}
  .miss{width:${PANE}px;height:${Math.round((PANE / 1280) * 824)}px;border-radius:4px;background:#5d5d5d;
        color:#fff;display:grid;place-items:center;text-align:center;padding:0 40px;font-size:13px}
`;

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: PANE * 2 + 42, height: 1000 }, deviceScaleFactor: 1.4 });

let n = 0;
for (const s of states) {
  const row = (theme) => {
    const shot = `${ROOT}app/${s.id}-${theme}.png`;
    const rec = app.get(s.id);
    const why = rec?.why ?? "not in the app's table";
    const right = existsSync(shot)
      ? `<img src="../app/${s.id}-${theme}.png">`
      : `<div class="miss">The app was not driven into this state.<br><br>${why}</div>`;
    return `
      <div class="cap">Drawing · ${theme}</div><div class="cap">Build · ${theme}</div>
      <figure><img src="../proto/${s.id}-${theme}.png"></figure>
      <figure>${right}</figure>`;
  };
  /* Written to disk and navigated to, rather than `setContent`: a page whose
     base is `about:blank` is refused every `file://` subresource it asks for,
     which draws four broken-image icons and no warning. */
  const html = `${OUT}/${s.id}.html`;
  writeFileSync(
    html,
    `<style>${css}</style>
     <h1>${s.group} — ${s.label}</h1>
     <div class="sub">${s.id}</div>
     <div class="grid">${row("light")}<div class="gap"></div>${row("dark")}</div>`,
  );
  await page.goto(`file://${html}`, { waitUntil: "load" });
  await page.waitForTimeout(140);
  await page.screenshot({ path: `${OUT}/${s.id}.png`, fullPage: true });
  n++;
  process.stdout.write(`\r  ${n}/${states.length}`.padEnd(40));
}

await browser.close();
console.log(`\n  ${n} sheets → ${OUT}`);
