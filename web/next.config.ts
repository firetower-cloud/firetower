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
 */
const nextConfig: NextConfig = {
  output: "export",
  turbopack: { root: __dirname },
};

export default nextConfig;
