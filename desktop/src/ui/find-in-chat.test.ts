import { describe, expect, it } from "vitest";
import { hits } from "./FindInChat";

/**
 * What ⌘F counts as a match.
 *
 * There is no DOM under these tests, and the part worth pinning down is not
 * the tree walk anyway — it is what somebody typing into the bar means. A
 * transcript is full of punctuation, so the two decisions that matter are that
 * the query is plain text rather than a pattern, and that two occurrences a
 * character apart are two matches rather than one.
 */
describe("finding a run of text", () => {
  it("ignores case, the way an editor's find bar does", () => {
    expect(hits("Cargo Build and cargo test", "cargo")).toEqual([0, 16]);
  });

  it("counts every occurrence, including ones that touch", () => {
    expect(hits("aaaa", "aa")).toEqual([0, 2]);
  });

  it("reads the query as characters, not as a pattern", () => {
    // As a regex this would match anything; as text it matches one place.
    expect(hits("ran ls .* here", ".*")).toEqual([7]);
    expect(hits("web/src/api/view.ts", "api/view.ts")).toEqual([8]);
  });

  it("finds nothing for an empty query, rather than a match at every gap", () => {
    expect(hits("anything", "")).toEqual([]);
  });

  it("says so when it is not there", () => {
    expect(hits("ran cargo fmt", "clippy")).toEqual([]);
  });
});
