/**
 * The rules that decide what the live script is allowed to write to.
 *
 * This is the one part of `cursor-live.mjs` worth a test. The rest needs a
 * renderer, a database and a browser, but these two functions are pure, and
 * what they are guarding against is an edit — a default put back for
 * convenience, an http fallback copied from the app — rather than a bug that
 * would ever show up in a run that went well.
 *
 * Two of these read the script as text, which is a coarse instrument. Each
 * one proves it found what it is talking about first: a test that passes
 * because its subject was renamed out from under it is worse than no test.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { origin, refusal } from "./target.mjs";

const SCRIPT = readFileSync(new URL("./cursor-live.mjs", import.meta.url), "utf8");
const FIRETOWER = { version: "0.34.2", eventsPath: "/api/v1/events", authModes: ["password"] };

describe("the address it is told", () => {
  it("has no default — the one it used to have is a developer's own server", () => {
    expect(SCRIPT).toMatch(/process\.env\.FIRETOWER_E2E_SERVER/);
    expect(SCRIPT).not.toMatch(/FIRETOWER_E2E_SERVER\s*(\?\?|\|\|)/);
    // Named in a comment, which is the only place it belongs; quoted is a
    // default, whichever way round it is written.
    expect(SCRIPT).not.toMatch(/["']\s*127\.0\.0\.1:4400/);
  });

  it("refuses to run without one, the way it refuses without a password", () => {
    expect(() => origin(undefined)).toThrow(/Set FIRETOWER_E2E_SERVER/);
    expect(() => origin("   ")).toThrow(/Set FIRETOWER_E2E_SERVER/);
  });

  it("keeps http for this machine, where a local install has no certificate", () => {
    expect(origin("127.0.0.1:4471")).toBe("http://127.0.0.1:4471");
    expect(origin("localhost:4471")).toBe("http://localhost:4471");
    expect(origin("[::1]:4471")).toBe("http://[::1]:4471");
    expect(origin("http://127.0.0.1:4471/")).toBe("http://127.0.0.1:4471");
  });

  it("will not downgrade a remote address to http, and will not be told to", () => {
    expect(origin("ft-e1.tail9c2b.ts.net")).toBe("https://ft-e1.tail9c2b.ts.net");
    expect(() => origin("http://ft-e1.tail9c2b.ts.net")).toThrow(/will not put one on the wire/);
    expect(origin("https://ft-e1.tail9c2b.ts.net")).toBe("https://ft-e1.tail9c2b.ts.net");
  });

  it("takes neither another scheme nor something that is not an address", () => {
    expect(() => origin("file:///etc/passwd")).toThrow(/file:\/\//);
    expect(() => origin("http://")).toThrow(/is not an address/);
  });
});

describe("the server that answers", () => {
  it("is this script's only if nobody has set it up", () => {
    expect(refusal({ ...FIRETOWER, serverId: null, organization: null }, "http://127.0.0.1:4471")).toBe(null);
    // `serverId` is the named organisation's id, so either field means set up.
    expect(refusal({ ...FIRETOWER, serverId: "org_1", organization: "Westlabs" }, "http://127.0.0.1:4400"))
      .toMatch(/already set up \(Westlabs\)[\s\S]*FIRETOWER_E2E_SERVER/);
    expect(refusal({ ...FIRETOWER, serverId: "org_1", organization: null }, "x")).toMatch(/already set up/);
  });

  it("has to be a Firetower at all", () => {
    expect(refusal(null, "http://127.0.0.1:9999")).toMatch(/not a Firetower/);
    expect(refusal({ hello: "there" }, "http://127.0.0.1:9999")).toMatch(/not a Firetower/);
  });

  it("is asked before anything is written to it", () => {
    const asked = SCRIPT.indexOf("refusal(");
    const written = SCRIPT.indexOf("/api/v1/auth/password");
    expect(asked).toBeGreaterThan(-1);
    expect(written).toBeGreaterThan(-1);
    expect(asked).toBeLessThan(written);
  });
});
