import { describe, expect, it } from "vitest";
import { toggled } from "~/ui/config/Machines";

/**
 * The sessions that ran on a removed machine are reachable from two places,
 * and the one that matters is the line under the card: the notice above it can
 * be dismissed, and the record cannot — hiding the row rather than showing it
 * inert is what makes that click-through load-bearing.
 *
 * QA found it broken in exactly one state. The list under the line was gated
 * on there being no chores left as well as on the toggle, so with a chore
 * outstanding *and* the notice dismissed, neither copy of the list drew and
 * the control flipped its own label over nothing.
 */
describe("which copy of the session list is open", () => {
  it("opens under the control that was pressed, whatever else is on screen", () => {
    // The state of the repro: the notice is dismissed and its chores are
    // outstanding. Nothing about either is an input here, which is the fix.
    expect(toggled(null, "foot")).toBe("foot");
    expect(toggled(null, "notice")).toBe("notice");
  });

  it("closes when the same control is pressed again", () => {
    expect(toggled("foot", "foot")).toBe(null);
    expect(toggled("notice", "notice")).toBe(null);
  });

  /** So it is drawn once, under the thing that asked for it. */
  it("moves rather than duplicating when the other control is pressed", () => {
    expect(toggled("notice", "foot")).toBe("foot");
    expect(toggled("foot", "notice")).toBe("notice");
  });
});
