import { describe, expect, it } from "vitest";
import { fromPatch, isNew } from "./patch";

/**
 * `isNew` reads the header and stops.
 *
 * It used to run `/^new file mode/m` over the whole patch, which is a scan of
 * everything the agent wrote to answer a question about its first five lines —
 * paid for every file in the sheet on every poll. Reading only above the first
 * hunk is both cheaper and stricter: a diff that *contains* the words is a diff
 * of a file that talks about git, not a file that was created.
 */
describe("whether a patch creates the file", () => {
  const head = "diff --git a/src/auth.ts b/src/auth.ts";

  it("sees a new file", () => {
    expect(isNew(`${head}\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/src/auth.ts\n@@ -0,0 +1 @@\n+ok\n`)).toBe(true);
  });

  it("does not see one in a file that was already there", () => {
    expect(isNew(`${head}\nindex 1111111..2222222 100644\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-a\n+b\n`)).toBe(false);
  });

  it("is not fooled by a hunk that happens to say it", () => {
    expect(isNew(`${head}\nindex 1111111..2222222 100644\n@@ -1 +1,2 @@\n a\n+new file mode 100644\n`)).toBe(false);
  });

  it("answers for a patch with no hunks at all — a rename, a mode change", () => {
    expect(isNew(`${head}\nsimilarity index 100%\nrename from src/old.ts\nrename to src/auth.ts\n`)).toBe(false);
    expect(isNew(`${head}\nnew file mode 100644\nBinary files /dev/null and b/src/auth.ts differ\n`)).toBe(true);
  });
});

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
