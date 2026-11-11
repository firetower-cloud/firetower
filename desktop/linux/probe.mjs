/**
 * Where the probe's answers land.
 *
 * One HTTP endpoint, because the alternative was reading WebKitGTK's console
 * out of a release build's stdout, which does not go there. Writes one JSON
 * file per phase into the output directory and keeps running until it is
 * killed — `check.sh` starts it once and runs several app launches past it.
 *
 *   node probe.mjs <port> <out-dir>
 */
import { createServer } from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const PORT = Number(process.argv[2] ?? 4499);
const OUT = process.argv[3] ?? "/out";
mkdirSync(OUT, { recursive: true });

/* The page's origin is `tauri://localhost`, so every answer is cross-origin
   and a browser will not even deliver it without these. Getting this wrong
   cost three runs: the probe ran, the POST failed with WebKit's unhelpful
   `TypeError: Load failed`, and it looked exactly like a probe that never
   executed. `scripts/mock-server.mjs` answers `OPTIONS` for the same reason,
   which is why the application could reach it and this could not. */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "*",
};

createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(200, { ...CORS, "content-type": "text/plain" });
    res.end("probe collector\n");
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let phase = "unknown";
    try {
      phase = JSON.parse(body).phase || "unknown";
    } catch {
      /* keep it anyway — an unparseable answer is still evidence */
    }
    const file = path.join(OUT, `probe-${phase}.json`);
    writeFileSync(file, body);
    console.log(`probe: ${body.length} bytes -> ${file}`);
    res.writeHead(204, CORS);
    res.end();
  });
}).listen(PORT, "127.0.0.1", () => console.log(`probe collector on :${PORT}`));
