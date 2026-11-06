import { describe, expect, test } from "vitest";
import { panelKeyOf } from "./panel";

describe("whose panel state a path uses", () => {
  /* The panel is collapsed when a workspace opens, because the sheet there is
     a conversation and the width belongs to it. A workspace is in the
     Dashboard's destination but it is not the Dashboard's question. */
  test("a workspace has its own answer, apart from the Dashboard's", () => {
    expect(panelKeyOf("/sessions/w_1")).toBe("work");
    expect(panelKeyOf("/")).toBe("home");
  });

  test("everything else is its destination's", () => {
    expect(panelKeyOf("/tasks")).toBe("tasks");
    expect(panelKeyOf("/configuration/skills")).toBe("customize");
  });

  /* A screen with no destination still needs somewhere to put the answer, and
     the Dashboard's is the one it came from. */
  test("and a screen with no destination borrows the Dashboard's", () => {
    expect(panelKeyOf("/account")).toBe("home");
  });
});
