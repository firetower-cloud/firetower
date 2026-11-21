import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SchedulesPinned, pausedBySave } from "./Pinned";

/**
 * What the team editor says before Save.
 *
 * The number comes from `AgentTeam.schedules` — the approved schedules
 * pinning the team — and the only way to get this wrong is the singular,
 * which is also the commonest case. *Saving this pauses 1 schedules* is the
 * whole of what this test exists to stop.
 */
describe("how many schedules a save would pause", () => {
  it("draws nothing at none, so the editor has no box saying zero", () => {
    expect(pausedBySave(0)).toBeNull();
    expect(pausedBySave(-1)).toBeNull();
  });

  it("names one in the singular, and says how it comes back", () => {
    expect(pausedBySave(1)).toBe(
      "Saving this pauses 1 schedule that runs as this team. It will not run again until you turn it back on.",
    );
  });

  it("and the ticket's own number in the plural", () => {
    expect(pausedBySave(4)).toBe(
      "Saving this pauses 4 schedules that run as this team. They will not run again until you turn them back on.",
    );
  });
});

/**
 * **#515 — a count of other people's unattended work, beside a Save they
 * cannot press.**
 *
 * The number is counted across every owner, and has to be: somebody about to
 * stop four schedules must be told four, including ones they will never be
 * allowed to read. So what changes is who is handed it, not what it counts —
 * and a reader of a shared team is handed nothing.
 */
describe("who the notice is for", () => {
  const draw = (count: number, mayWrite: boolean) =>
    renderToStaticMarkup(<SchedulesPinned count={count} mayWrite={mayWrite} />);

  it("says it to somebody who could press Save", () => {
    expect(draw(4, true)).toContain("pauses 4 schedules");
  });

  it("and nothing at all to somebody who could not", () => {
    expect(draw(4, false)).toBe("");
    expect(draw(1, false)).toBe("");
  });
});
