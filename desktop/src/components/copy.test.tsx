import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./Markdown";
import { Copyable } from "./ui";

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

/**
 * The wiring, not the clipboard.
 *
 * There is no DOM under these tests — no `navigator`, no selection — so what is
 * worth checking is what a transcript actually offers: which things come with a
 * way to take them away, and which do not.
 */
describe("what comes with a copy control", () => {
  it("puts one on a fenced block", () => {
    expect(html(<Markdown>{"```sh\nls -la\n```"}</Markdown>)).toContain("Copy this block");
  });

  it("puts one on a bare fence, which is how a drawing arrives", () => {
    expect(html(<Markdown>{"```\n┌──┐\n└──┘\n```"}</Markdown>)).toContain("Copy this block");
  });

  it("leaves a sentence and the code chips in it alone", () => {
    const out = html(<Markdown>{"see `web/app/page.tsx` for it"}</Markdown>);
    expect(out).not.toContain("Copy this block");
  });

  it("names what it copies, so the title is not four identical buttons", () => {
    const out = html(
      <Copyable text="whatever" label="Copy what it printed">
        <pre>whatever</pre>
      </Copyable>,
    );
    expect(out).toContain('aria-label="Copy what it printed"');
    expect(out).toContain("whatever");
  });
});
