import { describe, expect, it } from "vitest";
import { isBlockCode } from "./Markdown";

/**
 * Whether a `<code>` is a drawing or a path in a sentence.
 *
 * This exists because of the drawings. Agents write diagrams in bare ```
 * fences, which carry no `language-*` class — so a rule that asked for one
 * classified every drawing as inline code, gave it `white-space: nowrap`, and
 * rendered a twelve-line box as a single line scrolling off to the right.
 */
describe("whether a code element is a block", () => {
  it("is a block for a bare fence, which is how every drawing arrives", () => {
    expect(isBlockCode(true, undefined)).toBe(true);
  });

  it("is a block for a fence that names a language", () => {
    expect(isBlockCode(true, "language-rust")).toBe(true);
  });

  it("is a block for a fence still being streamed, which has no closing ```", () => {
    // An unclosed fence runs to the end of the document, so it is a code node
    // and lands inside a `<pre>` like any other — which is the whole reason
    // the answer comes from structure rather than from the text.
    expect(isBlockCode(true, undefined)).toBe(true);
  });

  it("is a chip for code in a sentence", () => {
    expect(isBlockCode(false, undefined)).toBe(false);
  });

  it("is a block for a language class reached some other way", () => {
    // Belt and braces: nothing generates this today, and treating tagged code
    // as prose would be the worse of the two mistakes.
    expect(isBlockCode(false, "language-ts")).toBe(true);
  });
});
