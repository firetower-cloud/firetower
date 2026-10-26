/**
 * What the shipped window is allowed to load.
 *
 * This file exists because of a bug that development could not show. Tauri
 * injects `app.security.csp` into the documents it serves *itself* — the built
 * frontend, behind `tauri://localhost` — and `pnpm dev` is not that: the page
 * comes from Vite over `http://localhost:5273`, never passes through the asset
 * protocol, and so carries no policy at all. Every mistake in this string is
 * therefore a production-only mistake, invisible to the person making it.
 *
 * One shipped. Thumbnails became an `<img>` against the control plane
 * (`ArtifactShot`) while `img-src` was still `'self' data: blob:`, which is
 * every artifact's origin except the one it is now loaded from — so a release
 * build drew the placeholder for every tile and a development build drew the
 * picture.
 *
 * So the addresses the app actually asks for, asserted against the policy it
 * actually ships. A Firetower is wherever somebody put it, which is why these
 * are schemes rather than hosts: there is no list of origins to enumerate.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const conf = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src-tauri/tauri.conf.json", import.meta.url)), "utf8"),
) as { app: { security: { csp: string } } };

const csp = conf.app.security.csp;

function sources(directive: string): string[] {
  const found = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d === directive || d.startsWith(`${directive} `));
  return found ? found.split(/\s+/).slice(1) : [];
}

/**
 * Whether a directive would let the window load an address.
 *
 * Only the shapes this policy is written in — a bare scheme, a keyword, an
 * exact origin — because a general CSP evaluator is a second implementation to
 * be wrong in its own way. If a source expression that is none of those is
 * ever added here, this says no and the test that cares fails loudly, which is
 * the right way round.
 */
function allows(directive: string, address: string): boolean {
  const url = new URL(address);
  return sources(directive).some(
    (src) => src === "*" || src === url.protocol || src === url.origin,
  );
}

/** The address `ArtifactShot` builds: `apiBase()` plus the signed poster path. */
const poster = (base: string) =>
  `${base}/__firetower/poster/a_01jc-3f2a9c81d0e4b7a6.png?v=v_01jc`;

describe("the shell's content policy", () => {
  it("lets a thumbnail load from a control plane", () => {
    expect(allows("img-src", poster("https://firetower.example.com"))).toBe(true);
  });

  /* The self-hosted case, which is most of them: a Firetower on a laptop or
     inside a network is an http origin on a port nobody can predict. */
  it("lets one load from a Firetower that is not on the public internet", () => {
    expect(allows("img-src", poster("http://localhost:8080"))).toBe(true);
    expect(allows("img-src", poster("http://10.0.0.4:3000"))).toBe(true);
  });

  /* The two that were already there and are load-bearing elsewhere: a pasted
     screenshot in the composer is `data:`, and a workspace picture read
     through the API with its bearer token is `blob:`. */
  it("still lets a picture that never left the app draw", () => {
    expect(allows("img-src", "data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    expect(allows("img-src", "blob:tauri://localhost/8f2c-1d")).toBe(true);
  });

  /* The point of widening images and nothing else. `default-src 'self'` is
     what keeps script off every origin above, and there is no `script-src` to
     override it — if one is ever added, this is where to notice. */
  it("does not let anything execute from off the machine", () => {
    expect(sources("script-src")).toEqual([]);
    expect(sources("default-src")).toEqual(["'self'"]);
  });
});
