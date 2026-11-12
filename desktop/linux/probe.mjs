/**
 * Where the probe's answers land.
 *
 * One HTTP endpoint, because the alternative was reading WebKitGTK's console
 * out of a release build's stdout, which does not go there. Writes one JSON
 * file per phase into the output directory and keeps running until it is
 * killed — `check.sh` starts it once and runs several app launches past it.
 *
 *   node probe.mjs <port> <out-dir> <secret>
 *
 * and the page posts to `/probe?s=<secret>`.
 *
 * **It is a file writer on an open port, and it is treated as one.** The
 * page's answers name the file they are stored as, and the first version of
 * this joined that name onto the output directory unchecked — so a `phase` of
 * `/../../escaped` wrote outside it. Anything running in the harness WebView
 * could reach that: there is no browser-level barrier on a POST to loopback,
 * the collector accepts every origin because it has to, and an artifact page
 * is somebody else's HTML running in the same window. So a submission now has
 * to carry the run's secret, the phase has to be a plain name, the resolved
 * path has to still be inside the output directory, and the body has a
 * ceiling. None of this ships — the collector exists only inside the
 * container — but a harness that can be made to write a file anywhere is a
 * harness nobody should run against an artifact they did not write.
 */
import { createServer } from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const PORT = Number(process.argv[2] ?? 4499);
const OUT = path.resolve(process.argv[3] ?? "/out");
/** Shared with the injected probe by `check.sh`, per run. Empty means refuse. */
const SECRET = process.argv[4] ?? "";
mkdirSync(OUT, { recursive: true });

/** How much of an answer to read before hanging up. */
const CEILING = 1 << 20;

/**
 * A phase name that can only ever be a file in `OUT`.
 *
 * Letters, digits and dashes, which is every phase `check.sh` actually uses
 * (`p`, `p-alive`, `p-bridge`). No dots, so `..` cannot be spelled; no
 * separators, so no directory can be named. The length bound is so a phase
 * cannot be a path by being longer than one.
 */
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

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
  /* In the query string rather than a header, so the submission stays a
     CORS-simple request: a custom header would make every POST ask for a
     preflight first, which is the thing `send()` in `probe.js` goes out of
     its way to avoid. Checked before a byte of the body is read, so an
     unauthorised caller cannot make this hold a megabyte for it either. */
  let offered = null;
  try {
    offered = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("s");
  } catch {
    /* an unparseable request line is not an authorised one */
  }
  if (!SECRET || offered !== SECRET) {
    console.log("probe: refused a submission with no run secret");
    res.writeHead(403, CORS);
    res.end();
    return;
  }

  let body = "";
  let over = false;
  req.on("data", (c) => {
    body += c;
    if (body.length > CEILING && !over) {
      over = true;
      console.log(`probe: refused ${body.length} bytes, over the ceiling`);
      res.writeHead(413, CORS);
      res.end();
      req.destroy();
    }
  });
  req.on("end", () => {
    if (over) return;
    let phase = "unknown";
    try {
      phase = JSON.parse(body).phase || "unknown";
    } catch {
      /* keep it anyway — an unparseable answer is still evidence */
    }
    if (typeof phase !== "string" || !PLAIN.test(phase)) {
      console.log(`probe: refused the phase name ${JSON.stringify(phase)}`);
      res.writeHead(400, CORS);
      res.end();
      return;
    }

    const file = path.resolve(OUT, `probe-${phase}.json`);
    /* Belt as well as braces: `PLAIN` is what makes this true, and this is
       what makes it checked. A name that got past the pattern and still
       resolved somewhere else would be the interesting one. */
    if (path.dirname(file) !== OUT) {
      console.log(`probe: refused ${file}, which is not in ${OUT}`);
      res.writeHead(400, CORS);
      res.end();
      return;
    }

    try {
      writeFileSync(file, body);
    } catch (e) {
      /* A full disk or a read-only mount is a result too, and silence here
         reads exactly like a probe that never ran. */
      console.log(`probe: could not write ${file}: ${e}`);
      res.writeHead(500, CORS);
      res.end();
      return;
    }
    console.log(`probe: ${body.length} bytes -> ${file}`);
    res.writeHead(204, CORS);
    res.end();
  });
}).listen(PORT, "127.0.0.1", () => console.log(`probe collector on :${PORT}`));
