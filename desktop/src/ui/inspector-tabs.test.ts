import { describe, expect, test } from "vitest";
import { shownTab, tabsFor, type TabId } from "./Inspector";

const ids = (hasRepo: boolean, mayAct: boolean) => tabsFor(hasRepo, mayAct).map((t) => t.id);

describe("which tabs a workspace has", () => {
  test("an ordinary one has all three", () => {
    expect(ids(true, true)).toEqual(["diff", "files", "ship"]);
  });

  /* The whole point: a diff of no checkouts is empty by construction and the
     server refuses the commit, so both were panels that could only say
     nothing. */
  test("a bare agent has only Files", () => {
    expect(ids(false, true)).toEqual(["files"]);
  });

  test("Commit still needs maySpeak, repository or not", () => {
    expect(ids(true, false)).toEqual(["diff", "files"]);
    expect(ids(false, false)).toEqual(["files"]);
  });
});

describe("the tab actually drawn", () => {
  test("is the remembered one when it is still there", () => {
    expect(shownTab(tabsFor(true, true), "ship")).toBe("ship");
    expect(shownTab(tabsFor(false, true), "files")).toBe("files");
  });

  /* Remembered "Diff" from the last workspace, opened on a bare one. Without
     the fallback this draws a tab strip with Files on it and an empty Diff
     underneath. */
  test("falls back when the remembered tab is gone", () => {
    expect(shownTab(tabsFor(false, true), "diff")).toBe("files");
    expect(shownTab(tabsFor(false, true), "ship")).toBe("files");
  });

  /* The behaviour that existed before bare workspaces did, kept: somebody who
     cannot commit, opening a workspace they were last on Commit in, lands on
     Diff rather than on Files. */
  test("a sharer who cannot commit still lands on Diff", () => {
    expect(shownTab(tabsFor(true, false), "ship")).toBe("diff");
  });

  test("and an unknown tab is survivable", () => {
    expect(shownTab(tabsFor(false, true), "nonsense" as TabId)).toBe("files");
  });
});
