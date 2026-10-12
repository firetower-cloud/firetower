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

/**
 * A repository with no commits in it.
 *
 * There is no trunk, so there is nothing to open a pull request against — and
 * a button promising one could only be refused by the host. The first session
 * pushes instead, and that push is what creates the trunk.
 */
describe("the first session on an empty repository", () => {
  const fresh = (over: Partial<CheckoutWork> = {}) =>
    checkout({ unborn: true, pushed: false, ...over });

  it("names the push rather than a pull request", () => {
    const ship = shipping(session, [fresh({ uncommitted: 3 })]);
    expect(ship.stage).toBe("uncommitted");
    expect(ship.seeds).toBe(true);
    expect(ship.label).toBe("Commit & push main");
  });

  it("names the trunk it is about to create", () => {
    const ship = shipping(session, [fresh({ base: "trunk", ahead: 1, commits: 1 })]);
    expect(ship.stage).toBe("unpushed");
    expect(ship.seeds).toBe(true);
    expect(ship.label).toBe("Push trunk");
  });

  /// A push that created the branch and not the trunk — a ruleset on it,
  /// somebody else pushing one first — leaves `ahead` at zero with the trunk
  /// still missing. Offering a pull request there is offering a refusal.
  it("offers the push again when the trunk still is not there", () => {
    const ship = shipping(session, [
      checkout({ unborn: true, pushed: true, ahead: 0, commits: 2 }),
    ]);
    expect(ship.seeds).toBe(true);
    expect(ship.label).toBe("Push main");
  });

  /// The trunk exists now — this session's push made it — so the ordinary
  /// sequence is back, including the pull request for work done afterwards.
  it("offers a pull request once the trunk is there", () => {
    const ship = shipping(session, [checkout({ unborn: false, pushed: true, commits: 2 })]);
    expect(ship.stage).toBe("pushed");
    expect(ship.seeds).toBeFalsy();
    expect(ship.label).toBe("Open pull request");
  });

  /// One empty repository beside a full one still has a request to open, and
  /// the button has to name the step that covers both.
  it("keeps the pull request when another repository has a trunk", () => {
    const ship = shipping(session, [
      fresh({ ahead: 1, commits: 1 }),
      checkout({ path: "infra", slug: "acme/infra", ahead: 1, commits: 1, pushed: false }),
    ]);
    expect(ship.seeds).toBeFalsy();
    expect(ship.stage).toBe("unpushed");
    expect(ship.label).toBe("Push & open PR");
  });
});
