import { beforeEach, describe, expect, it } from "vitest";
import type { CheckoutWork } from "./generated/model";
import {
  beginCheckout,
  forgetCheckout,
  howItIsDoing,
  landed,
  markCheckout,
  refused,
  runsOn,
  settled,
} from "./checkouts";

const work = (over: Partial<CheckoutWork> = {}): CheckoutWork =>
  ({
    path: "web",
    slug: "acme/web",
    branch: "agent/fix",
    base: "main",
    uncommitted: 0,
    commits: 0,
    ahead: 0,
    pushed: true,
    ...over,
  }) as CheckoutWork;

describe("a run of checkouts", () => {
  beforeEach(() => forgetAll("s_1"));

  /**
   * The reason this store exists at all.
   *
   * Three repositories is three requests, and the run used to live in the
   * popover that started them — so closing it lost every answer, including
   * the refusal.
   */
  it("holds a repository per row, waiting, in the order they were asked for", () => {
    beginCheckout("s_1", ["acme/web", "acme/api"]);
    const [run] = runsOn("s_1");
    expect(run.repos.map((r) => r.slug)).toEqual(["acme/web", "acme/api"]);
    expect(run.repos.every((r) => r.state === "waiting")).toBe(true);
  });

  it("is not over while one is still fetching", () => {
    const id = beginCheckout("s_1", ["acme/web", "acme/api"]);
    markCheckout("s_1", id, "acme/web", "done", "./web");
    markCheckout("s_1", id, "acme/api", "fetching");
    expect(settled(runsOn("s_1")[0])).toBe(false);
  });

  /**
   * A repository the host refused is that repository's problem.
   *
   * The whole run reporting failure would say the other two never arrived,
   * and they did.
   */
  it("is over once every repository has landed or been refused", () => {
    const id = beginCheckout("s_1", ["acme/web", "acme/api", "acme/docs"]);
    markCheckout("s_1", id, "acme/web", "done", "./web");
    markCheckout("s_1", id, "acme/api", "done", "./api");
    markCheckout("s_1", id, "acme/docs", "failed", "repository not found");

    const run = runsOn("s_1")[0];
    expect(settled(run)).toBe(true);
    expect(landed(run)).toBe(2);
    expect(refused(run)).toBe(1);
  });

  it("keeps the host's own words for a refusal", () => {
    const id = beginCheckout("s_1", ["acme/docs"]);
    markCheckout("s_1", id, "acme/docs", "failed", "github.com refused the fetch");
    expect(runsOn("s_1")[0].repos[0].detail).toBe("github.com refused the fetch");
  });

  /** Two presses are two cards, not one card rewritten. */
  it("keeps runs apart", () => {
    const first = beginCheckout("s_1", ["acme/web"]);
    beginCheckout("s_1", ["acme/api"]);
    markCheckout("s_1", first, "acme/web", "done");

    expect(runsOn("s_1")).toHaveLength(2);
    expect(runsOn("s_1")[1].repos[0].state).toBe("waiting");
  });

  it("leaves another session's runs alone", () => {
    beginCheckout("s_1", ["acme/web"]);
    expect(runsOn("s_2")).toHaveLength(0);
  });

  it("forgets one that has been dismissed", () => {
    const id = beginCheckout("s_1", ["acme/web"]);
    forgetCheckout("s_1", id);
    expect(runsOn("s_1")).toHaveLength(0);
  });

  /* A mark for a run that is no longer there must not resurrect it. */
  it("ignores a mark for a run that has gone", () => {
    const id = beginCheckout("s_1", ["acme/web"]);
    forgetCheckout("s_1", id);
    markCheckout("s_1", id, "acme/web", "done");
    expect(runsOn("s_1")).toHaveLength(0);
  });
});

describe("what a checkout is doing", () => {
  /**
   * **Absent is not zero**, and drawing it as zero is the lie this guards.
   *
   * A host that stopped answering reports nothing; a workspace with nothing
   * left to do reports zeros. Drawn the same, an afternoon of uncommitted work
   * on an unreachable machine reads as "nothing changed yet".
   */
  it("says the machine did not answer rather than claiming nothing changed", () => {
    expect(howItIsDoing(work({ uncommitted: null }), false).text).toBe("no answer from the machine");
  });

  it("says nothing changed only when the machine actually said zero", () => {
    expect(howItIsDoing(work({ uncommitted: 0, commits: 0 }), false).text).toBe("nothing changed yet");
  });

  it("counts what is not committed", () => {
    expect(howItIsDoing(work({ uncommitted: 4 }), false).text).toBe("4 uncommitted");
  });

  it("counts what is committed and not pushed", () => {
    expect(howItIsDoing(work({ commits: 2, pushed: false }), false).text).toBe("2 to push");
  });

  /* A pull request is the end of the line and outranks the counts under it. */
  it("says where the change went once it has a pull request", () => {
    expect(howItIsDoing(work({ pullRequest: "https://github.com/acme/web/pull/1", uncommitted: 3 }), false).text).toBe(
      "pull request open",
    );
    expect(howItIsDoing(work({ pullRequest: "https://github.com/acme/web/pull/1", pullState: "merged" }), false).text).toBe(
      "merged",
    );
  });

  /**
   * An ended session has no worker to ask, so "reading…" would never finish.
   */
  it("does not claim to be reading a workspace that has ended", () => {
    expect(howItIsDoing(undefined, true).text).toBe("checked out");
    expect(howItIsDoing(undefined, false).text).toBe("reading…");
  });
});

/** Every run on a session, dropped — the store is module state between tests. */
function forgetAll(session: string) {
  for (const run of [...runsOn(session)]) forgetCheckout(session, run.id);
}
