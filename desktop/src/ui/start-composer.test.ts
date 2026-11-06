import { describe, expect, it } from "vitest";
import { matching } from "./StartComposer";

/**
 * Filtering the repository list.
 *
 * The rule is one line, and every way of getting it wrong is invisible until
 * somebody types: a missing fold loses `Firetower` to `firetower`, a prefix
 * match loses `api-gateway` to `firetower-cloud/api-gateway`, and a missing
 * trim loses everything to the space after a word.
 */
const REPOS = [
  { slug: "firetower-cloud/api-gateway" },
  { slug: "firetower-cloud/firetower" },
  { slug: "firetower-cloud/Firetower-CLI" },
  { slug: "other/discord-issue-bot" },
];

describe("which repositories a query leaves", () => {
  it("leaves all of them when nothing has been typed", () => {
    expect(matching(REPOS, "")).toEqual(REPOS);
    expect(matching(REPOS, "   ")).toEqual(REPOS);
  });

  it("matches the half of the slug anybody remembers, not just the owner", () => {
    expect(matching(REPOS, "api").map((r) => r.slug)).toEqual(["firetower-cloud/api-gateway"]);
  });

  it("ignores case on both sides", () => {
    expect(matching(REPOS, "FIRETOWER-CLI").map((r) => r.slug)).toEqual([
      "firetower-cloud/Firetower-CLI",
    ]);
    expect(matching(REPOS, "cli").map((r) => r.slug)).toEqual(["firetower-cloud/Firetower-CLI"]);
  });

  it("ignores the space left by a word somebody typed and went back from", () => {
    expect(matching(REPOS, " discord ").map((r) => r.slug)).toEqual(["other/discord-issue-bot"]);
  });

  it("leaves nothing when nothing matches, so the menu can say so", () => {
    expect(matching(REPOS, "no-such-thing")).toEqual([]);
  });
});
