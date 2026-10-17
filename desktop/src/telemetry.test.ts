import { afterEach, describe, expect, it, vi } from "vitest";
import { __test } from "./telemetry";
import type { Connected } from "./servers";

const server: Connected = {
  url: "https://ft.example",
  serverId: "o_1",
  org: "Acme",
  user: "u_1",
  token: "tok",
  addedAt: "2026-10-01T00:00:00Z",
};

const digest = (day: string) => ({ day, payload: { day, schema_version: 1 } });

/** The outbox response, then one reply per post, then the acknowledgement. */
function wire(outbox: unknown, posts: number[]) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  let post = 0;

  const fetchMock = vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });

    if (url.includes("/telemetry/pending")) {
      if (outbox === null) return { ok: false, status: 404 } as Response;
      return { ok: true, json: async () => outbox } as Response;
    }
    if (url.includes("/telemetry/delivered")) return { ok: true } as Response;

    // The gateway.
    const status = posts[post++] ?? 200;
    if (status === 0) throw new Error("network");
    return { ok: status >= 200 && status < 300, status } as Response;
  });

  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

type Call = { url: string; method: string; body?: unknown };

const posted = (calls: Call[]) => calls.filter((c) => c.url === "https://telemetry.test/v1/digests");
const acked = (calls: Call[]) =>
  calls.find((c) => c.url.includes("/telemetry/delivered"))?.body as { days: string[] } | undefined;

const outbox = (...days: string[]) => ({
  endpoint: "https://telemetry.test/v1/digests",
  digests: days.map(digest),
});

afterEach(() => vi.unstubAllGlobals());

describe("the courier", () => {
  it("delivers what is owed and acknowledges exactly that", async () => {
    const calls = wire(outbox("2026-10-13", "2026-10-14"), [200, 200]);
    await __test.carry(server);

    expect(posted(calls)).toHaveLength(2);
    expect(acked(calls)?.days).toEqual(["2026-10-13", "2026-10-14"]);
  });

  it("sends nothing when nothing is owed", async () => {
    const calls = wire(outbox(), []);
    await __test.carry(server);

    expect(posted(calls)).toHaveLength(0);
    expect(acked(calls)).toBeUndefined();
  });

  /// A disabled install has an empty outbox, so this is the same path as above
  /// — stated as its own case because it is the one that must never regress.
  it("has no way to send for an install that turned telemetry off", async () => {
    const calls = wire({ endpoint: "https://telemetry.test/v1/digests", digests: [] }, []);
    await __test.carry(server);

    expect(posted(calls)).toHaveLength(0);
  });

  it("acknowledges a digest the gateway will never accept", async () => {
    // 400 is permanent: a schema it does not know, a day outside its window.
    // Retrying it on every launch forever is the alternative.
    const calls = wire(outbox("2026-10-14"), [400]);
    await __test.carry(server);

    expect(posted(calls)).toHaveLength(1);
    expect(acked(calls)?.days).toEqual(["2026-10-14"]);
  });

  it("leaves a digest owed when the gateway is having a bad day", async () => {
    const calls = wire(outbox("2026-10-14"), [503]);
    await __test.carry(server);

    expect(posted(calls)).toHaveLength(1);
    expect(acked(calls), "a 5xx must not be acknowledged").toBeUndefined();
  });

  it("leaves a digest owed when there is no network", async () => {
    const calls = wire(outbox("2026-10-14"), [0]);
    await __test.carry(server);

    expect(acked(calls)).toBeUndefined();
  });

  /// The backlog stays a contiguous tail rather than a sequence with holes in
  /// it, and a gateway that is down is asked once rather than fourteen times.
  it("stops at the first transient failure and acknowledges only the prefix", async () => {
    const calls = wire(outbox("2026-10-12", "2026-10-13", "2026-10-14"), [200, 503, 200]);
    await __test.carry(server);

    expect(posted(calls), "it should not have tried the third").toHaveLength(2);
    expect(acked(calls)?.days).toEqual(["2026-10-12"]);
  });

  /// This build talks to several servers and they upgrade on their own
  /// schedules, so a control plane without the route is ordinary.
  it("says nothing to a control plane that is too old to have an outbox", async () => {
    const calls = wire(null, []);
    await __test.carry(server);

    expect(posted(calls)).toHaveLength(0);
    expect(acked(calls)).toBeUndefined();
  });

  it("carries the server's own token, and posts the payload untouched", async () => {
    const calls = wire(outbox("2026-10-14"), [200]);
    await __test.carry(server);

    const sent = posted(calls)[0];
    expect(sent.body).toEqual({ day: "2026-10-14", schema_version: 1 });
  });
});

describe("post", () => {
  it("maps statuses to the retry rule", async () => {
    for (const [status, expected] of [
      [200, "delivered"],
      [400, "refused"],
      [404, "refused"],
      // In the 4xx range and meaning the opposite of it: come back later.
      [408, "later"],
      [429, "later"],
      [500, "later"],
      [503, "later"],
    ] as const) {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status < 300, status }) as Response));
      expect(await __test.post("https://x/v1/digests", {}), `${status}`).toBe(expected);
    }
  });
});
