import { afterEach, describe, expect, it, vi } from "vitest";
import { atLeast, candidates, MIN_SERVER, packaged, PACKAGED_ORIGINS, reach } from "./probe";

const fine = { version: MIN_SERVER, eventsPath: "/api/v1/events", serverId: "o_1", organization: "Kev", authModes: ["password"] };

/** A `fetch` that answers `https://ft` the way each kind of server does. */
function server(kind: "answers" | "refuses" | "missing" | "old") {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.mode === "no-cors") {
      if (kind === "missing") throw new TypeError("Load failed");
      return new Response(null, { status: 200 });
    }
    if (kind === "refuses" || kind === "missing") throw new TypeError("Load failed");
    const body = kind === "old" ? { ...fine, version: "0.34.0" } : fine;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
}

describe("reach", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps a server that answers", async () => {
    vi.stubGlobal("fetch", server("answers"));
    const got = await reach("ft");
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.url).toBe("https://ft");
  });

  it("tells a server that refused the app from one that is not there", async () => {
    vi.stubGlobal("fetch", server("refuses"));
    expect(await reach("ft")).toMatchObject({ ok: false, why: "refused" });
  });

  it("calls a route that is missing unreachable, after trying both schemes", async () => {
    const f = server("missing");
    vi.stubGlobal("fetch", f);
    expect(await reach("ft")).toMatchObject({ ok: false, why: "unreachable" });
    const urls = f.mock.calls.map((c) => c[0]);
    expect(urls).toContain("https://ft/api/v1/bootstrap");
    expect(urls).toContain("http://ft/api/v1/bootstrap");
  });

  it("does not go on to the password for a server older than it needs", async () => {
    vi.stubGlobal("fetch", server("old"));
    expect(await reach("ft")).toMatchObject({ ok: false, why: "too-old", detail: "Firetower 0.34.0" });
  });
});

describe("atLeast", () => {
  it("reads three numbers", () => {
    expect(atLeast("0.34.1", "0.34.1")).toBe(true);
    expect(atLeast("0.35.0", "0.34.1")).toBe(true);
    expect(atLeast("1.0.0", "0.99.99")).toBe(true);
    expect(atLeast("0.34.0", "0.34.1")).toBe(false);
    expect(atLeast("0.34.1-rc.1", "0.34.1")).toBe(true);
  });
});

describe("candidates", () => {
  it("tries https before http for a bare name", () => {
    expect(candidates("ft2.westlabs.dev")).toEqual(["https://ft2.westlabs.dev", "http://ft2.westlabs.dev"]);
  });
});

describe("what a refusal means", () => {
  it("is the server being behind, for a client that ships", () => {
    for (const origin of PACKAGED_ORIGINS) expect(packaged(origin)).toBe(true);
  });

  it("is this build being a dev build, when the pages come from vite", () => {
    // No production allowlist has this, and none should: it would let any page
    // on anybody's dev server call a real control plane.
    expect(packaged("http://localhost:5273")).toBe(false);
    expect(packaged("")).toBe(false);
  });
});
