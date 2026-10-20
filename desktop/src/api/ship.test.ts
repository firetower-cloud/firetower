import { describe, expect, it } from "vitest";
import {
  atRisk,
  awaiting,
  berths,
  byDirectory,
  done,
  leafOf,
  middled,
  ready,
  requestFor,
  sequence,
  shipping,
  within,
} from "./ship";
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

  /**
   * **The label must not offer to open what is already open.**
   *
   * Reported on a Gitea session: the branch had a request, the sheet said
   * "Commit & open PR", and pressing it committed, pushed and then opened the
   * browser at the request that had been there all along. The step below this
   * one already drew the distinction — `Push — updates the PR` — and this one
   * did not. The stage stays `uncommitted` either way; only the promise changes.
   */
  it("says it will update an open request rather than open one", () => {
    const ship = shipping(session, [
      checkout({ uncommitted: 1, pullRequest: "https://github.com/acme/web/pull/1" }),
    ]);
    expect(ship.stage).toBe("uncommitted");
    expect(ship.label).toContain("updates the PR");
    expect(ship.label).not.toContain("open PR");
    // And the link is carried, so what is drawn can say which request.
    expect(ship.links).toHaveLength(1);
  });

  /** A merged request is finished; these commits need one of their own. */
  it("offers a new request once the old one is merged", () => {
    const ship = shipping(session, [
      checkout({
        uncommitted: 1,
        pullRequest: "https://github.com/acme/web/pull/1",
        pullState: "merged",
      }),
    ]);
    expect(ship.label).toContain("new PR");
    expect(ship.links).toHaveLength(1);
    /* **The link carries what became of it.** Without this the sheet drew
       "already opened" above a button offering to open a new one — two lines
       disagreeing about one request, where the state is what settles it. */
    expect(ship.links[0].state).toBe("merged");
  });

  /** With nothing opened yet the old wording is still the right one. */
  it("still offers to open the first one", () => {
    const ship = shipping(session, [checkout({ uncommitted: 1 })]);
    expect(ship.label).toContain("Commit & open PR");
  });

  /** On a GitLab the short form follows the host's noun. */
  it("uses the host's own short form", () => {
    const ship = shipping(
      session,
      [checkout({ uncommitted: 1, pullRequest: "https://gl/x/-/merge_requests/1" })],
      false,
      "merge request",
    );
    expect(ship.label).toContain("updates the MR");
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

/**
 * What a host calls a request to merge a branch reaches the button, the
 * sequence above it, and the line that says one is open.
 *
 * GitLab says merge request. "Open pull request" on a GitLab is the kind of
 * wrongness that makes somebody distrust everything else on the panel — and
 * the abbreviation matters as much as the long form, because the short one is
 * the button in the session header where there is no room for either.
 *
 * The default is the whole of the backward-compatibility story here: every
 * assertion above this block passes the noun not at all.
 */
describe("the word the host uses for a change", () => {
  const MR = "merge request";

  it("names a merge request on GitLab", () => {
    const ship = shipping(session, [checkout({ pushed: true, commits: 2 })], false, MR);
    expect(ship.stage).toBe("pushed");
    expect(ship.label).toBe("Open merge request");
  });

  it("abbreviates it the way GitLab does", () => {
    const ship = shipping(session, [checkout({ uncommitted: 3, pushed: false })], false, MR);
    expect(ship.stage).toBe("uncommitted");
    expect(ship.label).toBe("Commit & open MR");
  });

  it("pluralises it", () => {
    const ship = shipping(
      session,
      [
        checkout({ pushed: true, commits: 1 }),
        checkout({ path: "infra", slug: "acme/infra", pushed: true, commits: 1 }),
      ],
      false,
      MR,
    );
    expect(ship.label).toBe("Open 2 merge requests");
  });

  it("says one is open in the host's own word", () => {
    const ship = shipping(
      session,
      [checkout({ pullRequest: "https://git.acme.internal/acme/web/-/merge_requests/1" })],
      false,
      MR,
    );
    expect(ship.stage).toBe("open");
    expect(ship.label).toBe("Merge request open");
  });

  it("amends the one already open rather than promising another", () => {
    const ship = shipping(
      session,
      [
        checkout({
          ahead: 1,
          pushed: false,
          pullRequest: "https://git.acme.internal/acme/web/-/merge_requests/1",
        }),
      ],
      false,
      MR,
    );
    expect(ship.stage).toBe("open-behind");
    expect(ship.label).toContain("updates the MR");
  });

  /** Said with no noun, which is every caller that has not been taught yet. */
  it("still says pull request when nobody asked", () => {
    expect(shipping(session, [checkout({ pushed: true, commits: 2 })]).label).toBe(
      "Open pull request",
    );
    expect(sequence(shipping(session, [checkout({ uncommitted: 1, pushed: false })]))).toContain(
      "opens a pull request",
    );
  });

  it("writes the sequence out in the host's word", () => {
    const ship = shipping(session, [checkout({ uncommitted: 1, pushed: false })], false, MR);
    expect(sequence(ship, MR)).toContain("opens a merge request");
  });
});

/* ── Splitting the sheet per repository ────────────────────────────────── */

const file = (path: string, added = 1, removed = 0) => ({ path, added, removed });

describe("which files belong to which repository", () => {
  /**
   * The diff prefixes a file with its repository's directory **only when the
   * session holds more than one**. A prefix test that forgot that is what once
   * made a single-repo commit keep no files at all, so both shapes are pinned.
   */
  it("takes paths bare when there is only one repository", () => {
    expect(within("infra", "hello.sh", true)).toBe("hello.sh");
  });

  it("requires the prefix when there are several", () => {
    expect(within("infra", "infra/hello.sh", false)).toBe("hello.sh");
    expect(within("infra", "project/hello.sh", false)).toBeNull();
  });
});

describe("the sheet, per repository", () => {
  const two = [
    checkout({ slug: "tester/infra", path: "infra", uncommitted: 1 }),
    checkout({ slug: "root/project", path: "project", uncommitted: 0, ahead: 2 }),
  ];

  it("gives each repository its own stage and its own files", () => {
    const out = berths(
      session,
      two,
      [file("infra/hi.py"), file("project/a.ts"), file("project/b.ts")],
      false,
      () => "pull request",
    );

    expect(out).toHaveLength(2);
    expect(out[0].checkout.slug).toBe("tester/infra");
    expect(out[0].files.map((f) => f.path)).toEqual(["infra/hi.py"]);
    expect(out[0].ship.stage).toBe("uncommitted");

    // The second is further along — the exact case one session-wide stage
    // could not express.
    expect(out[1].files).toHaveLength(2);
    expect(out[1].ship.stage).toBe("unpushed");
  });

  /** Each host names its own, so a GitLab beside a GitHub says the right word. */
  it("asks for the noun per repository", () => {
    const out = berths(session, two, [], false, (slug) =>
      slug === "root/project" ? "merge request" : "pull request",
    );
    expect(out[1].ship.label).toContain("MR");
    expect(out[0].ship.label).not.toContain("MR");
  });
});

/* ── The file list when it is long ─────────────────────────────────────── */

describe("grouping a long file list", () => {
  /**
   * 81 flat rows sorted alphabetically put the least interesting files on
   * screen — `.env.example`, `.github/…`, `AGENTS.md` — and capping shows the
   * same uninformative head. Grouping carries the shape of the change.
   */
  it("gathers files by directory, biggest group first", () => {
    const out = byDirectory(
      [
        file("api/src/a.ts"),
        file("api/src/b.ts"),
        file("api/src/c.ts"),
        file("web/x.tsx"),
        file("README.md"),
      ],
      "",
      true,
    );
    expect(out.map((g) => [g.dir, g.files.length])).toEqual([
      ["api/src", 3],
      ["", 1],
      ["web", 1],
    ]);
  });

  it("puts a repository's own files under it and leaves the rest out", () => {
    const out = byDirectory([file("infra/a.py"), file("project/b.ts")], "infra", false);
    expect(out).toEqual([{ dir: "", files: [file("infra/a.py")] }]);
  });

  /** Ties fall back to the name, so the list cannot reshuffle between renders. */
  it("is stable when two groups are the same size", () => {
    const once = byDirectory([file("b/x"), file("a/y")], "", true);
    const again = byDirectory([file("a/y"), file("b/x")], "", true);
    expect(once.map((g) => g.dir)).toEqual(again.map((g) => g.dir));
  });
});

describe("naming a file in a narrow column", () => {
  it("shows the filename, which is the part that identifies it", () => {
    expect(leafOf("api-gateway/src/common/generated/for-you.ts")).toBe("for-you.ts");
  });

  /**
   * The reported wart: `api-gateway/src/common/generated/for-y…` cut at the
   * end, removing the only part worth reading.
   */
  it("cuts a long path in the middle, never at the filename", () => {
    const out = middled("api-gateway/src/common/generated/for-you-bands.service.ts", 40);
    expect(out).toContain("for-you-bands.service.ts");
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out).toContain("…");
  });

  it("leaves a short path alone", () => {
    expect(middled("src/a.ts", 40)).toBe("src/a.ts");
  });
});

/* ── What each repository's request says ───────────────────────────────── */

describe("aiming a request at the repository it opens in", () => {
  const issue = {
    source: "github" as const,
    repo: "acme/api",
    key: "42",
    keyword: "Closes" as const,
  };
  const said = { title: "feat: for-you", body: "The work.", refs: [issue], draft: false };

  /**
   * **The bug this pins.** The sheet built the body once, with the session's
   * primary repository, and the server broadcast it to every checkout — so
   * `Closes #42` went into both requests and merging the second closed
   * whatever `#42` happened to be in *that* repository.
   */
  it("closes the issue only in its own repository", () => {
    expect(requestFor(said, "acme/api").body).toContain("Closes #42");
  });

  it("qualifies and downgrades it everywhere else", () => {
    const body = requestFor(said, "acme/web").body;
    expect(body).toContain("Refs acme/api#42");
    expect(body).not.toContain("Closes");
    // And never the bare form, which would mean web's own #42.
    expect(body).not.toMatch(/(^|\s)#42/);
  });

  it("carries the title and the draft flag through", () => {
    expect(requestFor({ ...said, draft: true }, "acme/api")).toMatchObject({
      title: "feat: for-you",
      draft: true,
    });
  });

  /** An empty title is absent, so the server falls back to what was proposed. */
  it("sends no title rather than an empty one", () => {
    expect(requestFor({ ...said, title: "   " }, "acme/api").title).toBeNull();
  });
});
