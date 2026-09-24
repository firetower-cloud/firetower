/**
 * What the agent wrote, as a tree.
 *
 * The same `remark-parse` and `remark-gfm` the other two clients render
 * through, so that a nested list, a fenced block or a table *is* the same
 * thing on all three. The hand-rolled subset this replaces handled four
 * constructs — bold, inline code, fences, bullets — and drew everything else
 * as the characters that were typed: `## Heading` came out as `## Heading`, a
 * link came out with its brackets on, and a table came out as a wall of pipes.
 *
 * Parsing is kept apart from drawing because the rest of this client's logic
 * is: `react-native` is stubbed under the test runner, so a pure function over
 * text is the only part that can be checked without a renderer — and it is the
 * part where the interesting questions are.
 */
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root, RootContent, PhrasingContent } from "mdast";

export type { Root, RootContent, PhrasingContent };

const processor = unified().use(remarkParse).use(remarkGfm);

/** The tree for a piece of markdown. */
export function parse(text: string): Root {
  return processor.parse(text) as Root;
}

/**
 * A table's rows as plain strings, and how wide each column has to be.
 *
 * A phone has no room to be clever about this: the table scrolls sideways as
 * one grid, and a grid needs its columns to agree about their width before the
 * first cell is drawn. Measured in characters, because the font it is drawn in
 * is monospaced — the one place in this file where the renderer's choice leaks
 * into the parsing, and it is cheaper than measuring text on a UI thread.
 */
export function columns(rows: string[][]): number[] {
  const width: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      width[i] = Math.max(width[i] ?? 0, cell.length);
    });
  }
  return width;
}

/** The text of a run of inline nodes, with the formatting dropped. */
export function flatten(nodes: PhrasingContent[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
        case "inlineCode":
          return node.value;
        case "strong":
        case "emphasis":
        case "delete":
        case "link":
          return flatten(node.children as PhrasingContent[]);
        case "image":
          return node.alt ?? "";
        case "break":
          return " ";
        default:
          return "";
      }
    })
    .join("");
}
