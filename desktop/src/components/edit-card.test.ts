import { describe, expect, it } from "vitest";
import { editFrom } from "./EditCard";

/**
 * These shapes are the agents', not ours.
 *
 * The point of the tests is that we read what they actually send — and that an
 * argument list we do not recognise returns nothing rather than half a diff,
 * because the caller draws the ordinary row when it gets nothing and draws a
 * wrong diff when it gets something wrong.
 */
describe("reading an edit out of a tool call", () => {
  it("reads a replacement", () => {
    expect(
      editFrom({
        file_path: "src/auth.rs",
        old_string: "let a = 1;",
        new_string: "let a = 2;",
      }),
    ).toEqual({ path: "src/auth.rs", removed: "let a = 1;", added: "let a = 2;" });
  });

  it("reads a write as an addition with nothing removed", () => {
    expect(editFrom({ file_path: "NOTES.md", content: "# Notes\n" })).toEqual({
      path: "NOTES.md",
      removed: undefined,
      added: "# Notes\n",
    });
  });

  it("accepts the camelCase spelling", () => {
    expect(editFrom({ filePath: "a.ts", oldString: "x", newString: "y" })).toEqual({
      path: "a.ts",
      removed: "x",
      added: "y",
    });
  });

  it("takes an empty new string as a real deletion, not as absent", () => {
    // `""` is what removing the last line of a file looks like. Treating it as
    // missing would silently turn a deletion into "no diff to draw".
    expect(editFrom({ file_path: "a.ts", old_string: "gone", new_string: "" })).toEqual({
      path: "a.ts",
      removed: "gone",
      added: "",
    });
  });

  describe("returns nothing when", () => {
    it("there is no path", () => {
      expect(editFrom({ old_string: "a", new_string: "b" })).toBeNull();
    });

    it("there is a path but neither side of an edit", () => {
      expect(editFrom({ file_path: "a.ts" })).toBeNull();
    });

    it("the arguments never parsed", () => {
      expect(editFrom(undefined)).toBeNull();
      expect(editFrom(null)).toBeNull();
      expect(editFrom("Edit(a.ts)")).toBeNull();
    });

    it("the fields are there but are not strings", () => {
      expect(editFrom({ file_path: 12, old_string: "a" })).toBeNull();
      expect(editFrom({ file_path: "a.ts", old_string: { a: 1 }, new_string: [1] })).toBeNull();
    });
  });
});
