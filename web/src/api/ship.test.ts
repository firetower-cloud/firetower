import { describe, expect, it } from "vitest";
import { shipping, done, awaiting } from "./ship";
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
