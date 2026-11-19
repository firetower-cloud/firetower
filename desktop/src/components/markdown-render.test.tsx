import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
 * How wide a column is allowed to get, which is two rules in two files.
 *
 * **`overflow-wrap: anywhere` is not only a wrapping rule.** It is the one
 * value that also counts the break points it introduces when a box's
 * *min-content* width is measured — so, inherited from `.prose-desk .ft-md`
 * into every cell, it told the auto table algorithm that any column could be
 * about one character wide, and the algorithm duly spent the width on the
 * columns holding sentences. A three-column table of roles drew "Engineering
 * Manager" as `Enginee / ring / Manager` in a pane with room to spare.
 * `break-word` is the value that wraps the same long token without saying
 * that about the measurement, and the cells take it.
 *
 * Source-level, like `components/ui/reuse.test.ts` and
 * `ui/schedules/pages.test.ts`: the question is which rule the sheet carries,
 * and jsdom has no table layout algorithm to ask the better question. What
 * the rules *do* — a column 108px rather than 75px, every break at a space —
 * is held by `scripts/shoot-prose.mjs` against a real browser.
 */
describe("a table in a reply", () => {
  const SHEET = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");
  const rule = (selector: string) =>
    SHEET.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{[^}]*\\}`))?.[0] ?? "";

  it("breaks a cell at its spaces, not inside a word", () => {
    expect(rule(".prose-desk .ft-md th, .prose-desk .ft-md td")).toContain(
      "overflow-wrap: break-word",
    );
  });

  it("keeps `anywhere` for running text, which is what it was there for", () => {
    // A URL or a hash in a sentence still wraps rather than widening the
    // conversation. Taking this away is the other way to fix the columns, and
    // it is the wrong one.
    expect(rule(".prose-desk .ft-md")).toContain("overflow-wrap: anywhere");
  });

  it("scrolls when its cells cannot be made any narrower", () => {
    const TABLE = [
      "| Commit | Subject |",
      "| --- | --- |",
      "| b820cd7f0e7a4d2c91f8e5a6c3b7d4e2f1a09c8b | the columns stop collapsing |",
    ].join("\n");
    expect(html(TABLE)).toContain("overflow-x-auto");
  });
});
