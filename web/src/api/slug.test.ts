import { describe, expect, it } from "vitest";
import { slugify } from "./slug";

/**
 * This has to agree with `ft_core::slugify`.
 *
 * The control plane derives the branch itself when the client sends none, so a
 * field showing a different answer from the one that would actually happen is
 * worse than a field showing nothing. These cases are the Rust function's own
 * rules, written out: lowercase, non-alphanumerics become separators, a fixed
 * list of empty words is dropped, and four survive.
 */
describe("the name derived from a prompt", () => {
  it("drops the words that carry nothing", () => {
    expect(slugify("Split the refresh path out of auth")).toBe("split-refresh-path-out");
  });

  it("keeps four at most", () => {
    expect(slugify("one two three four five six")).toBe("one-two-three-four");
  });

  it("treats anything that is not a letter or a digit as a gap", () => {
    expect(slugify("Fix   auth/refresh (again!)")).toBe("fix-auth-refresh-again");
  });

  it("lowercases", () => {
    expect(slugify("Rewrite AuthService")).toBe("rewrite-authservice");
  });

  it("is empty when there is nothing to go on", () => {
    // The caller shows a placeholder rather than a name, and the control plane
    // has its own fallback for the same case.
    expect(slugify("")).toBe("");
    expect(slugify("   ")).toBe("");
    expect(slugify("the a an of")).toBe("");
  });

  it("keeps digits, which are usually a ticket number", () => {
    expect(slugify("fix #5138 promo codes")).toBe("fix-5138-promo-codes");
  });
});
