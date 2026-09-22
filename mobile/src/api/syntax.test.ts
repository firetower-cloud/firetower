import { describe, expect, it } from "vitest";
import { highlight, langNamed, TONE } from "./syntax";

const joined = (line: string, lang: string) => highlight(line, lang).map((p) => p.text).join("");

describe("highlight", () => {
  /* The one property that matters more than any colour: a highlighter that
     drops or reorders a character has corrupted the code it was asked to make
     readable. */
  it("gives back exactly the line it was given", () => {
    for (const [line, lang] of [
      ["const x = \"hi\"; // and a comment", "ts"],
      ["pub fn main() -> Result<(), String> { 42 }", "rust"],
      ["select * from agent_lines where line_no > 10;", "sql"],
      ["curl -s \"http://localhost:4400\" | head -c 200", "make"],
      ["", "ts"],
      ["   ", "ts"],
    ] as const) {
      expect(joined(line, lang)).toBe(line);
    }
  });

  it("keeps a keyword inside a comment a comment", () => {
    const pieces = highlight("// const is a keyword out here", "ts");
    expect(pieces.every((p) => p.kind === "comment")).toBe(true);
  });

  /* Numbers are still picked out — they are numbers in any language, and the
     desk does the same. Keywords are not, because `text` has none. */
  it("claims no keywords in a language it does not know", () => {
    const pieces = highlight("const x = 1", "text");
    expect(pieces.some((p) => p.kind === "keyword")).toBe(false);
    expect(pieces.map((p) => p.kind)).toContain("number");
  });

  it("has a tone for every kind it can emit", () => {
    for (const line of ["const a = \"s\" // c", "fn f() { 1 }"]) {
      for (const lang of ["ts", "rust"]) {
        for (const p of highlight(line, lang)) expect(TONE[p.kind]).toBeTruthy();
      }
    }
  });
});

describe("langNamed", () => {
  it("maps what a fence actually says", () => {
    expect(langNamed("ts")).toBe("ts");
    expect(langNamed("TSX")).toBe("ts");
    expect(langNamed("json")).toBe("ts");
    expect(langNamed("rs")).toBe("rust");
    expect(langNamed("bash")).toBe("make");
    expect(langNamed("")).toBe("text");
    expect(langNamed("brainfuck")).toBe("text");
  });
});
