/**
 * What the agent wrote, as a tree.
 *
 * The renderer needs `react-native`, which is stubbed here, so what can be
 * checked is the parse — and the parse is where the old hand-rolled subset
 * was wrong. Each case below is something it drew as the characters that were
 * typed.
 */
import { describe, expect, it } from "vitest";
import { columns, flatten, parse } from "./markdown";

const kinds = (text: string) => parse(text).children.map((n) => n.type);

describe("what the parse recognises", () => {
  it("sees a heading rather than two hashes and a word", () => {
    const [node] = parse("## What you should be seeing").children;
    expect(node.type).toBe("heading");
    expect(node).toMatchObject({ depth: 2 });
  });

  it("sees a link rather than brackets", () => {
    const [para] = parse("see [the docs](https://example.com) for more").children;
    expect(para.type).toBe("paragraph");
    const link = (para as { children: { type: string; url?: string }[] }).children.find(
      (c) => c.type === "link",
    );
    expect(link?.url).toBe("https://example.com");
  });

  it("sees a picture, and keeps its alt text", () => {
    const [para] = parse("![the panel](docs/shot.png)").children;
    const image = (para as { children: { type: string; url?: string; alt?: string }[] }).children[0];
    expect(image).toMatchObject({ type: "image", url: "docs/shot.png", alt: "the panel" });
  });

  it("sees a table rather than a wall of pipes", () => {
    const table = parse("| a | b |\n|---|---|\n| 1 | 2 |\n").children[0];
    expect(table.type).toBe("table");
  });

  it("keeps a quote, a rule and a fence apart", () => {
    expect(kinds("> quoted\n\n---\n\n```rs\nfn main() {}\n```\n")).toEqual([
      "blockquote",
      "thematicBreak",
      "code",
    ]);
  });

  it("numbers an ordered list from where it says", () => {
    const list = parse("3. third\n4. fourth\n").children[0];
    expect(list).toMatchObject({ type: "list", ordered: true, start: 3 });
  });

  it("nests a list inside a list", () => {
    const list = parse("- one\n  - deeper\n").children[0] as {
      children: { children: { type: string }[] }[];
    };
    expect(list.children[0].children.map((c) => c.type)).toContain("list");
  });

  /* The fence has to survive being half-written: the markdown is reparsed on
     every delta of a streaming turn, and for most of one a fence is open. */
  it("does not fall apart on a fence that has not been closed yet", () => {
    expect(kinds("here:\n\n```ts\nconst x = 1")).toEqual(["paragraph", "code"]);
  });
});

describe("flatten", () => {
  it("reads a cell's text without its formatting", () => {
    const para = parse("**bold** and `code` and [a link](x)").children[0] as {
      children: Parameters<typeof flatten>[0];
    };
    expect(flatten(para.children)).toBe("bold and code and a link");
  });
});

describe("columns", () => {
  it("is as wide as the widest cell in each", () => {
    expect(columns([["a", "bbbb"], ["cc", "d"]])).toEqual([2, 4]);
  });

  it("copes with a ragged row rather than dropping it", () => {
    expect(columns([["a"], ["bb", "ccc"]])).toEqual([2, 3]);
  });
});
