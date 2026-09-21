import { describe, expect, it } from "vitest";
import { shipping, done, awaiting, ready, atRisk } from "./ship";
import type { CheckoutWork, Session } from "./generated/model";

const session = { id: "s_1", repo: "acme/web", checkouts: [] } as unknown as Session;

const checkout = (over: Partial<CheckoutWork> = {}): CheckoutWork =>
  ({
    path: "",
    slug: "acme/web",
    branch: "agent/fix",
    base: "main",
    uncommitted: 0,
    ahead: 0,
    pushed: true,
    ...over,
  }) as CheckoutWork;

/**
 * A workspace stayed open whatever became of the change in it.
 *
 * The panel drew "View pull request" for ever, because the stages stopped at
 * `open` and nothing ever asked the git host what happened next.
 */
describe("what became of the pull request", () => {
  it("says merged once every request went in", () => {
    const ship = shipping(session, [
      checkout({ pullRequest: "https://github.com/acme/web/pull/1", pullState: "merged" }),
    ]);
    expect(ship.stage).toBe("merged");
  });

  it("says closed when one was abandoned", () => {
    const ship = shipping(session, [
      checkout({ pullRequest: "https://github.com/acme/web/pull/1", pullState: "closed" }),
    ]);
    expect(ship.stage).toBe("closed");
  });

  /// Nobody has asked yet, which is not the same as asked and still open.
  it("stays open while nothing has answered", () => {
    const ship = shipping(session, [
      checkout({ pullRequest: "https://github.com/acme/web/pull/1" }),
    ]);
    expect(ship.stage).toBe("open");
  });

  /// The honest next step is the one still waiting for a reviewer.
  it("stays open while any request is still out", () => {
    const ship = shipping(session, [
      checkout({ pullRequest: "https://github.com/acme/web/pull/1", pullState: "merged" }),
      checkout({
        path: "infra",
        slug: "acme/infra",
        pullRequest: "https://github.com/acme/infra/pull/2",
        pullState: "open",
      }),
    ]);
    expect(ship.stage).toBe("open");
  });

  /// Unsaved work comes first however the request ended: a merged request does
  /// not make an uncommitted file safe to lose.
  it("does not hide work that is still unsaved", () => {
    const ship = shipping(session, [
      checkout({
        uncommitted: 2,
        pullRequest: "https://github.com/acme/web/pull/1",
        pullState: "merged",
      }),
    ]);
    expect(ship.stage).toBe("uncommitted");
  });
});

describe("whether to keep asking the git host", () => {
  it("keeps asking while a request is open", () => {
    expect(awaiting(shipping(session, [checkout({ pullRequest: "u" })]))).toBe(true);
  });

  it("stops once every one is settled", () => {
    const merged = shipping(session, [checkout({ pullRequest: "u", pullState: "merged" })]);
    expect(awaiting(merged)).toBe(false);
    expect(done(merged)).toBe(true);
  });

  it("stops when there is no request at all", () => {
    expect(awaiting(shipping(session, [checkout({ pushed: false })]))).toBe(false);
  });
});

/**
 * The bug that made an afternoon of an agent's work look like no work at all.
 *
 * A host that stopped answering and a workspace with nothing in it arrived here
 * as the same thing — an absent `work`, or a row of zeros — and both were drawn
 * as "clean". The whole point of these is that not knowing is its own state.
 */
describe("not knowing is not the same as nothing", () => {
  it("says so when the request failed, rather than sitting on Looking…", () => {
    const ship = shipping(session, undefined, true);
    expect(ship.stage).toBe("unknown");
    expect(ship.blocked).toMatch(/can't reach/i);
  });

  it("still says Looking… while the request is in flight", () => {
    const ship = shipping(session, undefined, false);
    expect(ship.stage).toBe("clean");
    expect(ship.blocked).toBe("Looking…");
  });

  /// The counts arrive absent rather than as zeros when the worker could not
  /// read the checkout. Absent must not fall through to "nothing to commit".
  it("does not read an unreadable checkout as a clean one", () => {
    const ship = shipping(session, [
      checkout({ uncommitted: undefined, ahead: undefined, pushed: undefined }),
    ]);
    expect(ship.stage).toBe("unknown");
  });

  it("passes on what the worker said was wrong with it", () => {
    const ship = shipping(session, [
      checkout({ uncommitted: undefined, trouble: "fatal: not a git repository" }),
    ]);
    expect(ship.blocked).toBe("fatal: not a git repository");
  });

  /// One unreadable repository out of two is not half a clean session.
  it("does not average an unreadable checkout away", () => {
    const ship = shipping(session, [
      checkout({ slug: "acme/web", uncommitted: 0, ahead: 0 }),
      checkout({ slug: "acme/api", uncommitted: undefined }),
    ]);
    expect(ship.stage).toBe("unknown");
  });

  /// Nothing is offered from a state nothing is known about.
  it("offers no action while the state is unknown", () => {
    expect(ready(shipping(session, undefined, true))).toBe(false);
    expect(ready(shipping(session, [checkout({ uncommitted: undefined })]))).toBe(false);
  });
});

/**
 * What closing a workspace is allowed to promise.
 *
 * `atRisk` is what decides whether ending a session warns first. A checkout
 * nobody could read may be holding anything, so it has to count as at risk —
 * the cost of a needless warning is a sentence, the cost of the reverse is the
 * work itself.
 */
describe("what would be lost", () => {
  it("treats an unreadable checkout as work at risk", () => {
    expect(atRisk([checkout({ uncommitted: undefined })])).toBe(true);
  });

  it("still says nothing is at risk when everything is known and pushed", () => {
    expect(atRisk([checkout({ uncommitted: 0, ahead: 0, pushed: true })])).toBe(false);
  });
});
