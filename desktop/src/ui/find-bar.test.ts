import { describe, expect, it } from "vitest";
import { CAP, countOf } from "./FindBar";

/**
 * What the count beside the field says.
 *
 * One bar is drawn over the conversation and over an artifact, and the
 * conversation answers its own query at once while an artifact waits on a
 * reply from another window. So there are two ways to have nothing to say —
 * no query, and no answer yet — and both must read as nothing rather than as
 * `none`, which is a verdict about text that was actually searched.
 */
describe("what the count says", () => {
  it("says nothing with no query", () => {
    expect(countOf("", { count: 0, at: 0 })).toBe("");
    expect(countOf("   ", { count: 0, at: 0 })).toBe("");
  });

  it("says nothing until the search has answered", () => {
    expect(countOf("cargo", null)).toBe("");
  });

  it("says none, in a word, when the query is not there", () => {
    expect(countOf("clippy", { count: 0, at: 0 })).toBe("none");
  });

  it("counts from one, the way a person does", () => {
    expect(countOf("cargo", { count: 12, at: 0 })).toBe("1/12");
    expect(countOf("cargo", { count: 12, at: 11 })).toBe("12/12");
  });

  it("marks a count that stopped at the cap, because it did", () => {
    expect(countOf("a", { count: CAP, at: 599 })).toBe("600/600+");
    expect(countOf("a", { count: CAP - 1, at: 0 })).toBe("1/599");
  });
});
