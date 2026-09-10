// Serve the production export for browser tests, including extensionless pages.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
const root = resolve("out");
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
createServer(async (request, response) => {
  const path = resolve(
    root,
    "." + new URL(request.url, "http://localhost").pathname,
  );
  if (path !== root && !path.startsWith(root + "/")) {
    response.writeHead(403).end();
    return;
  }
  for (const file of [path, path + ".html", path + "/index.html"]) {
    try {
      const body = await readFile(file);
      response
        .writeHead(200, {
          "content-type": types[extname(file)] || "application/octet-stream",
        })
        .end(body);
      return;
    } catch {
      /* Try the export's page variants. */
    }
  }
  response
    .writeHead(404)
    .end("Build the web export with pnpm build before running browser tests.");
}).listen(3000, "0.0.0.0");

// A real loopback server keeps Chromium's local-network checks active. A
// fulfilled navigation has no peer address and would be treated as public.
createServer(async (request, response) => {
  const script =
    new URL(request.url, "http://localhost").pathname ===
    "/__firetower/annotations.js";
  const body = await readFile(
    script
      ? "../crates/ft-server/src/preview/annotations.js"
      : "e2e/preview-fixture.html",
  );
  if (request.url.startsWith("/strict"))
    response.setHeader("content-security-policy", "frame-src 'none'");
  response
    .writeHead(200, {
      "content-type": script
        ? "text/javascript; charset=utf-8"
        : "text/html; charset=utf-8",
    })
    .end(body);
}).listen(48080, "0.0.0.0");
