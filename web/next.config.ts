import type { NextConfig } from "next";

/**
 * The interface is a static export, embedded in the control plane's binary.
 *
 * Everything here renders in the browser and reads the API over HTTP, so there
 * is nothing for a Node server to do at runtime. Exporting means the release is
 * one binary and one port: no second process to supervise, no reverse proxy to
 * make two origins look like one, and no API base baked in at build time —
 * `apiBase()` falls through to the page's own origin, which is the path it
 * prefers anyway.
 *
 * **Only when building.** `output: "export"` enforces its rules in `next dev`
 * as well, and one of them is that a dynamic route may only be visited with a
 * param listed in `generateStaticParams`. Session ids are made at runtime, so
 * opening a session on the dev server failed with:
 *
 *     Page "/sessions/[id]/page" is missing param "/sessions/[id]" in
 *     "generateStaticParams()", which is required with "output: export"
 *
 * In a real deployment that constraint is satisfied a different way: the export
 * writes one shell, `sessions/_.html`, and the control plane serves it for any
 * session — see `crates/ft-server/src/web.rs`. The dev server has no such
 * fallback and does not need one, because it is a dev server.
 *
 * The cost of this is that `next dev` is no longer identical to what ships, so
 * something that breaks the export can get as far as `just build`. That is
 * where it stops, and it is a better trade than not being able to open a
 * session while developing.
 */
const nextConfig: NextConfig = {
  ...(process.env.NODE_ENV === "production" ? { output: "export" as const } : {}),
  turbopack: { root: __dirname },
};

export default nextConfig;
