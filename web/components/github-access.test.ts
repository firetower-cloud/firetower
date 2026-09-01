import { describe, expect, it } from "vitest";
import { accessUrl, ownersOf, reach, whatChanged } from "./GitHubAccess";
import type { RemoteRepo } from "@/src/api/generated/model";

const repo = (slug: string): RemoteRepo => ({
  slug,
  remote: `https://github.com/${slug}.git`,
  defaultBranch: "main",
  private: false,
  pushedAt: null,
});

/**
 * The question this screen exists to answer: did authorizing again actually
 * buy anything? A grant that went through and a request still waiting on an
 * owner look identical from here unless the two lists are compared, and
 * reporting the second as success is how somebody ends up filing the same
 * issue twice.
 */
describe("what a re-authorization bought", () => {
  it("names the organizations that became visible", () => {
    const said = whatChanged(
      [repo("you/notes")],
      [repo("you/notes"), repo("acme/backend"), repo("acme/web")],
    );
    expect(said).toContain("2 more repositories");
    expect(said).toContain("acme");
  });

  it("says plainly when nothing changed", () => {
    const said = whatChanged([repo("you/notes")], [repo("you/notes")]);
    expect(said).toContain("Nothing new");
    // And why, because the next move is asking somebody, not clicking again.
    expect(said).toContain("owner");
  });

  it("counts a single repository in the singular", () => {
    expect(whatChanged([], [repo("acme/backend")])).toContain("1 more repository");
  });

  it("only names organizations that are new", () => {
    // A repository added inside an organization already granted is not a new
    // organization, and saying it is would credit the wrong thing.
    const said = whatChanged([repo("acme/backend")], [repo("acme/backend"), repo("acme/web")]);
    expect(said).toBe("1 more repository is visible now.");
  });

  it("lists several new organizations readably", () => {
    const said = whatChanged(
      [],
      [repo("acme/backend"), repo("labs/thing"), repo("you/notes")],
    );
    expect(said).toContain("acme, labs and you");
  });
});

describe("who a token can see", () => {
  it("keeps each owner once, in the order the host returned them", () => {
    expect(ownersOf([repo("acme/backend"), repo("you/notes"), repo("acme/web")])).toEqual([
      "acme",
      "you",
    ]);
  });

  it("counts repositories and owners for the settings line", () => {
    expect(reach([repo("acme/backend")])).toBe("1 repository across 1 account or organization");
    expect(reach([repo("acme/backend"), repo("you/notes")])).toBe(
      "2 repositories across 2 accounts and organizations",
    );
    // Connected but sharing nothing is a real state, and it should read as one
    // rather than as an error.
    expect(reach([])).toBe("0 repositories across 0 accounts and organizations");
  });
});

/**
 * The link is the half of this that authorizing again cannot do, and it is
 * unbuildable without the client id — which is why the status carries one.
 */
describe("where access is reviewed on the host", () => {
  it("is built from the client id being authorized against", () => {
    expect(accessUrl("Ov23liEXAMPLE")).toBe(
      "https://github.com/settings/connections/applications/Ov23liEXAMPLE",
    );
  });

  it("is nothing at all when no application is registered", () => {
    // Rather than a link to a page that 404s, which reads as our bug.
    expect(accessUrl(null)).toBeNull();
    expect(accessUrl(undefined)).toBeNull();
    expect(accessUrl("  ")).toBeNull();
  });
});
