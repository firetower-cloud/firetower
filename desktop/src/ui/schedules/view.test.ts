import { describe, expect, test } from "vitest";
import type { ScheduleRun, ScheduleRunState } from "~/api/generated/model";
import { inFlight, runLine, settled, stillMoving } from "./view";

function run(over: Partial<ScheduleRun>): ScheduleRun {
  return {
    id: "run_1",
    scheduleId: "sch_1",
    fireAt: "2026-11-11T07:00:00Z",
    revision: 1,
    state: "finished",
    source: "cron",
    workspaceKept: false,
    ...over,
  } as ScheduleRun;
}

/**
 * **The defect this file exists for.**
 *
 * `runLine` ended in `"Finished."` for any run with no sentence yet — which
 * is every run between being claimed and being settled. Pressing *Run now*
 * therefore drew a finished run before anything had started, and a run the
 * capacity gate then refused kept that line. Telling somebody their
 * unattended work ran when it did not is the worst thing this screen can do.
 */
describe("a run's line never claims an outcome it does not have", () => {
  const UNSETTLED: ScheduleRunState[] = ["claimed", "running"];

  test.each(UNSETTLED)("a %s run with no sentence does not read as finished", (state) => {
    const line = runLine(run({ state, detail: null, summary: null }));
    expect(line).not.toMatch(/finished/i);
    expect(line.length).toBeGreaterThan(0);
  });

  /* Each of the five "nothing was started" states says which, rather than
     borrowing a word from the one state that means the work happened. */
  test.each([
    ["refused", /refused/i],
    ["skipped", /skipped/i],
    ["missed", /missed/i],
    ["lost", /did not start/i],
    ["failed", /failed/i],
  ] as const)("a %s run says so on its own", (state, says) => {
    expect(runLine(run({ state, detail: null, summary: null }))).toMatch(says);
    expect(runLine(run({ state, detail: null, summary: null }))).not.toMatch(/^Finished\.$/);
  });

  /* The server's sentence is the one the history is meant to carry, and it
     wins over everything — including over the state's own fallback. */
  test("the server's sentence wins", () => {
    expect(
      runLine(run({ state: "refused", detail: "Refused. wren was low on disk.", summary: null })),
    ).toBe("Refused. wren was low on disk.");
  });

  test("and the agent's own summary comes next", () => {
    expect(runLine(run({ state: "finished", detail: null, summary: "Opened #4412" }))).toBe(
      "Opened #4412",
    );
  });

  /* A finished run with nothing to say is the one case the plain word is
     true of — a schedule with no repository, where nothing summarises a run
     and the outcome and the timing are all there is. */
  test("only a finished run reads as finished", () => {
    expect(runLine(run({ state: "finished", detail: null, summary: null }))).toBe("Finished.");
  });
});

/**
 * **Stop the run offered itself for a run that never started.**
 *
 * A claimed run is still being launched: there is no agent and no workspace,
 * so there is nothing to stop and the teardown it would call has nothing to
 * act on.
 */
describe("which run Stop the run acts on", () => {
  test("a running one, holding a session", () => {
    const live = run({ state: "running", sessionId: "s_1" });
    expect(inFlight([live])?.id).toBe(live.id);
  });

  test("not one that is merely claimed", () => {
    expect(inFlight([run({ state: "claimed", sessionId: null })])).toBeUndefined();
  });

  test("and not a running one with no session to end", () => {
    expect(inFlight([run({ state: "running", sessionId: null })])).toBeUndefined();
  });

  test("nor anything settled", () => {
    for (const state of ["finished", "refused", "failed", "missed", "skipped", "lost"] as const) {
      expect(inFlight([run({ state, sessionId: "s_1" })])).toBeUndefined();
    }
  });
});

/** What the page polls on. A claimed run counts: it is the window where the
 *  client knows least and the server is about to know more. */
describe("whether the page should keep looking", () => {
  test("while a run is claimed or running", () => {
    expect(stillMoving([run({ state: "claimed" })])).toBe(true);
    expect(stillMoving([run({ state: "running" })])).toBe(true);
  });

  test("and not once everything has settled", () => {
    expect(stillMoving([run({ state: "refused" }), run({ state: "finished" })])).toBe(false);
    expect(stillMoving([])).toBe(false);
  });

  test("settled is read from the state", () => {
    expect(settled(run({ state: "claimed" }))).toBe(false);
    expect(settled(run({ state: "refused" }))).toBe(true);
  });
});
