/**
 * Leaving a team with a draft on it.
 *
 * **Save being the only commit is the whole promise of this screen**, and a
 * surface that drops unsaved work on the way out breaks it quietly. That was
 * shipped: navigating away discarded the draft and said nothing, which the
 * prototype's own D5 flagged as the transition it was least sure of and which
 * QA confirmed on the build.
 *
 * Two halves are worth pinning. The router has to consult a guard and obey
 * what it answers, and the sentence the question puts on screen has to say
 * what leaving would cost — a bare *2 changes* does not tell somebody whether
 * a subtree is about to go.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { leaveGuard } from "~/shims/next-navigation";
import { describeChanges } from "./TeamMap";
import type { Change } from "./team-map";

afterEach(() => leaveGuard.clear());

describe("the router's leave guard", () => {
  test("nothing is registered by default, so navigation is not gated", () => {
    expect(leaveGuard.armed()).toBe(false);
    expect(leaveGuard.ask(() => {})).toBe(false);
  });

  /* The screen answers per call: a map with nothing pending lets the address
     change without a word, which is every navigation on this pane but one. */
  test("a guard that answers false lets the navigation through", () => {
    const resume = vi.fn();
    expect(leaveGuard.ask(resume)).toBe(false);
    expect(resume).not.toHaveBeenCalled();
  });
});

describe("what the question says is at stake", () => {
  const add = (n: number): Change[] =>
    Array.from({ length: n }, (_, i) => ({ kind: "add", key: `new-${i}`, profile: "r_1" }));
  const remove = (under: number): Change =>
    ({ kind: "remove", id: "p_1", profile: "r_1", under });

  test("one of each reads as English", () => {
    expect(describeChanges(add(1))).toBe("Not saved yet: one position added.");
    expect(describeChanges([remove(0)])).toBe("Not saved yet: one taken out.");
    expect(describeChanges(add(3))).toBe("Not saved yet: 3 positions added.");
  });

  /**
   * **A removal counts what goes, not what was pressed.**
   *
   * The pending count beside Save is one per gesture, which is right there —
   * it says how many decisions are waiting. Here the question is what leaving
   * would cost, and taking out a position with three under it costs four
   * cards. The two numbers are different on purpose.
   */
  test("a removed subtree says how many cards go, not how many presses", () => {
    expect(describeChanges([remove(3)])).toBe("Not saved yet: 4 taken out.");
  });

  test("several kinds are joined rather than listed as a number", () => {
    expect(describeChanges([...add(2), remove(1)])).toBe(
      "Not saved yet: 2 positions added and 2 taken out.",
    );
    expect(
      describeChanges([...add(1), remove(0), { kind: "move", id: "p_2", profile: "r_2" }]),
    ).toBe("Not saved yet: one position added, one taken out and one moved.");
  });

  /* It is never drawn at nothing — the guard answers false first — but a
     sentence that reads as a bug if it ever escaped is worth one line. */
  test("nothing pending has nothing to say", () => {
    expect(describeChanges([])).toBe("Nothing is saved yet.");
  });
});
