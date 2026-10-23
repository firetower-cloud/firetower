import { describe, expect, test } from "vitest";
import { leafOf } from "./download";

/**
 * What the save sheet opens showing.
 *
 * The whole of the logic worth pinning here: the URLs are two query strings
 * and the server decides the real filename from `content-disposition`, but
 * this is what somebody sees before anything has been fetched, and getting it
 * wrong means a sheet suggesting `workspace` for a file called `render.mp4`.
 */
describe("the suggested name", () => {
  test("is the last part of the path", () => {
    expect(leafOf("out/clips/one.mp4")).toBe("one.mp4");
    expect(leafOf("notes.txt")).toBe("notes.txt");
  });

  test("is the directory itself, for a directory", () => {
    expect(leafOf("out/clips")).toBe("clips");
  });

  /* A trailing slash is a path somebody can produce by joining, and
     `split("/").pop()` on it is the empty string — which would suggest a file
     with no name at all. */
  test("survives a trailing slash", () => {
    expect(leafOf("out/clips/")).toBe("clips");
  });

  /* The empty path is the whole workspace. There is no leaf, and the sheet
     still has to open on something — the server sends the workspace's own
     name, so this is only what is shown before it answers. */
  test("falls back for the workspace itself", () => {
    expect(leafOf("")).toBe("workspace");
  });
});
