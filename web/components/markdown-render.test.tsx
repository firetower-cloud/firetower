import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./Markdown";

const html = (md: string) => renderToStaticMarkup(<Markdown>{md}</Markdown>);

const DRAWING = ["```", "┌─────┐", "│  a  │", "└─────┘", "```"].join("\n");

/**
 * The whole point of the component, checked end to end.
 *
 * `isBlockCode` covers the rule; this covers the wiring, which is where it
 * actually went wrong — the rule was fine in isolation and was being asked the
 * wrong question.
 */
describe("what a drawing renders as", () => {
  it("keeps a bare fence on as many lines as it was written on", () => {
    const out = html(DRAWING);
    expect(out).toContain("whitespace-pre");
    expect(out).not.toContain("whitespace-nowrap");
    // The newlines are still newlines, which is what `nowrap` used to eat.
    expect(out).toContain("┌─────┐\n│  a  │\n└─────┘");
  });

  it("renders a tagged fence the same way", () => {
    expect(html("```rust\nlet a = 1;\n```")).toContain("whitespace-pre");
  });

  it("still draws code in a sentence as a chip", () => {
    const out = html("see `crates/ft-core/src/lib.rs` for it");
    expect(out).toContain("whitespace-nowrap");
    expect(out).not.toContain("whitespace-pre");
  });

  it("leaves a block free of the prose measure, and holds prose to it", () => {
    expect(html(DRAWING)).not.toContain("max-w-[72ch]");
    expect(html("a sentence")).toContain("max-w-[72ch]");
  });
});
