import { describe, expect, it } from "vitest";
import { addressed, keyOf, nextResume } from "./frames";
import type { ServerFrame } from "./generated/model";

const line = (id: string): ServerFrame =>
  ({ t: "line", id, lineNo: 1, type: "TurnStarted", turn: "turn-1" }) as unknown as ServerFrame;

const reset = (id?: string): ServerFrame =>
  ({ t: "reset", topic: id ? "conversation" : "sessions", ...(id ? { id } : {}) }) as ServerFrame;

const event = (): ServerFrame =>
  ({ t: "event", event: { seq: 1, sessionId: "s_a", kind: {}, at: "" } }) as unknown as ServerFrame;

describe("which listener a frame is for", () => {
  it("gives a conversation line to that conversation and no other", () => {
    expect(addressed(line("s_a"), { topic: "conversation", id: "s_a" })).toBe(true);
    expect(addressed(line("s_a"), { topic: "conversation", id: "s_b" })).toBe(false);
    // The reason the whole page can share one connection: a frame for one open
    // tab must not reach the others.
    expect(addressed(line("s_a"), { topic: "sessions" })).toBe(false);
  });

  it("gives every session event to the one subscription that draws them", () => {
    expect(addressed(event(), { topic: "sessions" })).toBe(true);
    expect(addressed(event(), { topic: "conversation", id: "s_a" })).toBe(false);
  });

  it("routes a reset to the subscription it names", () => {
    expect(addressed(reset("s_a"), { topic: "conversation", id: "s_a" })).toBe(true);
    expect(addressed(reset("s_a"), { topic: "conversation", id: "s_b" })).toBe(false);
    expect(addressed(reset(), { topic: "sessions" })).toBe(true);
  });

  it("keeps connection frames away from subscriptions", () => {
    expect(addressed({ t: "ready" } as ServerFrame, { topic: "sessions" })).toBe(false);
    expect(addressed({ t: "pong" } as ServerFrame, { topic: "conversation", id: "s_a" })).toBe(
      false,
    );
  });

  it("shares one subscription between listeners on the same thing", () => {
    expect(keyOf({ topic: "conversation", id: "s_a" })).toBe(
      keyOf({ topic: "conversation", id: "s_a" }),
    );
    expect(keyOf({ topic: "conversation", id: "s_a" })).not.toBe(
      keyOf({ topic: "conversation", id: "s_b" })
    );
  });
});

describe("resuming a subscription that was reset", () => {
  it("resumes at once the first time, because that is the common case", () => {
    // Falling behind is ordinary and recoverable. Waiting would show a stalled
    // conversation for no reason.
    expect(nextResume(undefined, 1_000)).toEqual({ wait: 0, run: 0 });
  });

  it("backs off when they keep coming, so a dead feed is not a tight loop", () => {
    // A subscription whose source has gone ends the moment it is re-established.
    // Without this the two ends spin against each other.
    const first = nextResume(undefined, 0);
    const second = nextResume({ at: 0, run: first.run }, 100);
    const third = nextResume({ at: 100, run: second.run }, 200);

    expect(second.wait).toBeGreaterThan(0);
    expect(third.wait).toBeGreaterThan(second.wait);
  });

  it("stops growing, so a feed that comes back is picked up promptly", () => {
    let last = { at: 0, run: 0 };
    for (let i = 1; i < 20; i += 1) {
      const next = nextResume(last, i * 10);
      last = { at: i * 10, run: next.run };
      expect(next.wait).toBeLessThanOrEqual(10_000);
    }
  });

  it("forgets the run once they stop, so a later reset is prompt again", () => {
    // Two resets an hour apart are not a loop, and the second should not be
    // punished for the first.
    const after = nextResume({ at: 0, run: 6 }, 60_000);
    expect(after).toEqual({ wait: 0, run: 0 });
  });
});
