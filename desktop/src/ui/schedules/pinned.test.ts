import { describe, expect, it } from "vitest";
import { pausedBySave } from "./Pinned";

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
