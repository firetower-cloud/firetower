import { describe, expect, test } from "vitest";
import { shownTab, tabsFor, type TabId } from "./Inspector";

const ids = (hasRepo: boolean, mayAct: boolean) => tabsFor(hasRepo, mayAct).map((t) => t.id);

describe("which tabs a workspace has", () => {
  /* Overview leads every workspace — it always has the plan, the branch and
     the links to show, and a team once there is one. */
  test("an ordinary one has all four, Overview first", () => {
    expect(ids(true, true)).toEqual(["overview", "diff", "files", "ship"]);
  });

  /* A diff of no checkouts is empty by construction and the server refuses the
     commit, so both drop away — but Overview and Files stay. */
  test("a bare agent keeps Overview and Files", () => {
    expect(ids(false, true)).toEqual(["overview", "files"]);
  });

  test("Commit still needs maySpeak, repository or not", () => {
    expect(ids(true, false)).toEqual(["overview", "diff", "files"]);
    expect(ids(false, false)).toEqual(["overview", "files"]);
  });
});

describe("the tab actually drawn", () => {
  test("is the remembered one when it is still there", () => {
    expect(shownTab(tabsFor(true, true), "ship")).toBe("ship");
    expect(shownTab(tabsFor(false, true), "files")).toBe("files");
  });

  /* Remembered "Diff" from the last workspace, opened on a bare one. Without
     the fallback this draws a tab strip without Diff and an empty panel under
     it — so it lands on the first tab, which is Overview. */
  test("falls back to Overview when the remembered tab is gone", () => {
    expect(shownTab(tabsFor(false, true), "diff")).toBe("overview");
    expect(shownTab(tabsFor(false, true), "ship")).toBe("overview");
    expect(shownTab(tabsFor(true, false), "ship")).toBe("overview");
  });

  test("and an unknown tab is survivable", () => {
    expect(shownTab(tabsFor(false, true), "nonsense" as TabId)).toBe("overview");
  });
});
