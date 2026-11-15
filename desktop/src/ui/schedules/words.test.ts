import { describe, expect, test } from "vitest";
import type { Schedule, Streak } from "~/api/generated/model";
import { offWord, pauseSays, pauseTag, stoppedByFiretower } from "./words";

const NONE: Streak = { counted: 0, failures: 0, questions: 0, unreachable: 0 };

/** A schedule, with only the fields these words read. */
function schedule(over: Partial<Schedule>): Schedule {
  return {
    active: false,
    pausedReason: null,
    approvedAt: "2026-11-01T09:00:00Z",
    streak: NONE,
    ...over,
  } as Schedule;
}

describe("which rule stopped it, in words", () => {
  test("three failures is kept failing", () => {
    const s = schedule({
      pausedReason: "three_failures",
      streak: { counted: 3, failures: 3, questions: 0, unreachable: 0 },
    });
    expect(pauseTag(s)).toBe("Kept failing");
    expect(pauseSays(s)?.headline).toContain("three runs failed");
  });

  test("five questions is kept needing you", () => {
    const s = schedule({
      pausedReason: "five_runs",
      streak: { counted: 5, failures: 0, questions: 5, unreachable: 0 },
    });
    expect(pauseTag(s)).toBe("Kept needing you");
    expect(pauseSays(s)?.headline).toContain("five runs needed you");
    expect(pauseSays(s)?.because).toContain("still waiting in their workspaces");
  });

  /** Five runs that were all one kind of failure names the machine. */
  test("five unreachable runs is kept failing, and names the machine", () => {
    const s = schedule({
      pausedReason: "five_runs",
      streak: { counted: 5, failures: 0, questions: 0, unreachable: 5 },
    });
    expect(pauseTag(s)).toBe("Kept failing");
    expect(pauseSays(s, "wren")?.headline).toContain("could not reach wren");
    /* And without one, it says the true thing rather than inventing a name. */
    expect(pauseSays(s, null)?.headline).toContain("five runs failed");
  });

  /**
   * **The mixed streak, which is the case nothing picks between.**
   *
   * Two failures and three questions is `five_runs` and is neither of the
   * other two tags. The tie-break that would have chosen one was deleted when
   * the column changed to store the rule rather than the cause.
   */
  test("a mixed streak gets its own tag and counts both populations", () => {
    const s = schedule({
      pausedReason: "five_runs",
      streak: { counted: 5, failures: 2, questions: 3, unreachable: 0 },
    });
    expect(pauseTag(s)).toBe("Kept failing and asking");

    const said = pauseSays(s);
    expect(said?.headline).toContain("five runs in a row did not finish");
    expect(said?.because).toContain("Two of them failed and three stopped to ask");
    expect(said?.because).toContain("Neither on its own would have stopped it");
  });

  /** An unreachable machine among questions is still the mixed case: it joined
   *  the streak, so it is part of what did not finish. */
  test("unreachable runs mixed with questions read as the mixed case", () => {
    const s = schedule({
      pausedReason: "five_runs",
      streak: { counted: 5, failures: 0, questions: 3, unreachable: 2 },
    });
    expect(pauseTag(s)).toBe("Kept failing and asking");
    expect(pauseSays(s)?.because).toContain("Two of them failed and three stopped to ask");
  });

  test("the overrun pause points at a run rather than at the history", () => {
    const s = schedule({ pausedReason: "overran" });
    expect(pauseTag(s)).toBe("Kept overrunning");
    expect(pauseSays(s)?.because).toContain("in that workspace rather than in this history");
  });

  test("a disabled owner keeps the plain sentence", () => {
    const s = schedule({ pausedReason: "owner_disabled" });
    expect(pauseTag(s)).toBe("Firetower stopped it");
    expect(pauseSays(s)?.because).toContain("Nothing was wrong with the schedule");
  });
});

describe("a schedule somebody paused reads differently from one that gave up", () => {
  test("no tag, and the column says Paused rather than Stopped", () => {
    const s = schedule({ pausedReason: null });
    expect(stoppedByFiretower(s)).toBe(false);
    expect(pauseTag(s)).toBeNull();
    expect(pauseSays(s)).toBeNull();
    expect(offWord(s)).toBe("Paused");
  });

  test("and one Firetower stopped says Stopped", () => {
    expect(offWord(schedule({ pausedReason: "three_failures" }))).toBe("Stopped");
  });

  /* A proposal has never run and has not been approved, so neither word is
     true of it. */
  test("one that has never been turned on says so", () => {
    expect(offWord(schedule({ pausedReason: null, approvedAt: null }))).toBe("Not on");
  });

  test("a running schedule has no tag at all", () => {
    expect(pauseTag(schedule({ active: true, pausedReason: null }))).toBeNull();
  });
});
