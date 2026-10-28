import { describe, expect, it } from "vitest";
import { readFound } from "./bridge";

/**
 * What the page may claim to have found.
 *
 * Everything on this channel arrives from an untrusted page, and this is the
 * one message whose numbers go straight into a label. The checks are the
 * obvious ones — whole, non-negative, the index inside the count — and the
 * point of pinning them is that a page cannot make the bar print nonsense,
 * however little the nonsense would matter.
 */
describe("what the page may claim to have found", () => {
  it("takes a count and the one that is on", () => {
    expect(readFound({ type: "found", count: 12, at: 3 })).toEqual({ count: 12, at: 3 });
    expect(readFound({ count: 1, at: 0 })).toEqual({ count: 1, at: 0 });
  });

  it("takes none, so the bar can say so", () => {
    expect(readFound({ count: 0, at: 0 })).toEqual({ count: 0, at: 0 });
  });

  it("refuses a position past the count", () => {
    expect(readFound({ count: 3, at: 3 })).toBeNull();
    expect(readFound({ count: 0, at: 1 })).toBeNull();
  });

  it("refuses anything that is not a whole number", () => {
    expect(readFound({ count: 2.5, at: 0 })).toBeNull();
    expect(readFound({ count: -1, at: 0 })).toBeNull();
    expect(readFound({ count: 2, at: -1 })).toBeNull();
    expect(readFound({ count: "2", at: 0 })).toBeNull();
    expect(readFound({ count: NaN, at: 0 })).toBeNull();
    expect(readFound({ count: Infinity, at: 0 })).toBeNull();
  });

  it("refuses a number too large to be a label", () => {
    expect(readFound({ count: 1e9, at: 0 })).toBeNull();
  });

  it("refuses a message with neither", () => {
    expect(readFound({ type: "found" })).toBeNull();
    expect(readFound({ count: 4 })).toBeNull();
  });
});
