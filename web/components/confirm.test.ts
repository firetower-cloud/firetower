import { describe, expect, it } from "vitest";
import { confirmed } from "./Confirm";

describe("typed confirmation", () => {
  it("lets anything through when nothing was asked for", () => {
    expect(confirmed(undefined, "")).toBe(true);
    expect(confirmed(undefined, "whatever")).toBe(true);
  });

  it("wants the exact words", () => {
    expect(confirmed("TURN IT OFF", "TURN IT OFF")).toBe(true);
    expect(confirmed("TURN IT OFF", "")).toBe(false);
    expect(confirmed("TURN IT OFF", "TURN IT")).toBe(false);
    expect(confirmed("TURN IT OFF", "TURN IT OFF NOW")).toBe(false);
  });

  /// A confirmation that accepts lower case is one that can be satisfied
  /// without reading it.
  it("is case-sensitive", () => {
    expect(confirmed("TURN IT OFF", "turn it off")).toBe(false);
    expect(confirmed("TURN IT OFF", "Turn It Off")).toBe(false);
  });

  /// A trailing space from a paste is not a different answer.
  it("forgives surrounding whitespace", () => {
    expect(confirmed("TURN IT OFF", "  TURN IT OFF  ")).toBe(true);
    expect(confirmed("TURN IT OFF", "TURN IT OFF\n")).toBe(true);
    // But not whitespace in the middle of it.
    expect(confirmed("TURN IT OFF", "TURN  IT  OFF")).toBe(false);
  });
});
