import { describe, expect, it } from "vitest";
import { fromPatch } from "./patch";

/**
 * The rows the inspector draws. Only the open file's patch is read now, but it
 * is read on every poll, so what comes back has to be exactly the lines — a
 * header leaking through is a row the window has counted and cannot place.
 */
describe("reading a patch into rows", () => {
  it("drops the headers and keeps the hunks", () => {
    expect(
      fromPatch(
        "diff --git a/a.ts b/a.ts\nindex 111..222 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@ fn\n ctx\n-gone\n+here\n",
      ),
    ).toEqual([
      ["hunk", "@@ -1,2 +1,2 @@ fn"],
      ["ctx", "ctx"],
      ["del", "gone"],
      ["add", "here"],
    ]);
  });

  it("keeps a binary file's one line, so the row is not silently nothing", () => {
    expect(fromPatch("diff --git a/x.png b/x.png\nindex 111..222 100644\nBinary files a/x.png and b/x.png differ\n")).toEqual([
      ["ctx", "Binary files a/x.png and b/x.png differ"],
    ]);
  });
});
