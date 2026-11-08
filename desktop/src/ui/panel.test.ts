import { describe, expect, test } from "vitest";
import { panelKeyOf } from "./panel";

describe("whose panel state a path uses", () => {
  /* The panel is collapsed when a workspace opens, because the sheet there is
     a conversation and the width belongs to it. A workspace is in the
     Dashboard's destination but it is not the Dashboard's question. */
  test("a workspace has its own answer, apart from everything else's", () => {
    expect(panelKeyOf("/sessions/w_1")).toBe("work");
    expect(panelKeyOf("/")).not.toBe("work");
  });

  /* **One answer, not one per destination.** It used to be keyed by
     destination, so collapsing the panel on the Dashboard and then clicking
     Tasks read a different slot — and every slot defaulted to open. From the
     outside that is the panel refusing to stay shut. */
  test("every destination shares one answer, so collapsed stays collapsed", () => {
    const one = panelKeyOf("/");
    for (const path of ["/tasks", "/artifacts", "/configuration/skills", "/updates", "/account"]) {
      expect(panelKeyOf(path)).toBe(one);
    }
  });
});
