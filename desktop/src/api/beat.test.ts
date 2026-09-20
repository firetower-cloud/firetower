/**
 * The two things that draw a status must agree about what it means.
 *
 * They did not. `Signal` painted `HandedBack` sage and `Failed` brick, while
 * the island asked `NEEDS_YOU` — which groups both in with `NeedsYou` — and
 * painted all three ember. The same workspace was green in the sidebar and
 * orange in the menu bar, and a rail row drew both at once.
 *
 * `BEAT` is now the only table that answers the question, so the way to keep
 * them together is to check that nothing has quietly grown a second opinion.
 */
import { describe, expect, it } from "vitest";
import type { SessionStatus } from "./generated/model";
import { BEAT, BEAT_TONE, IN_FLIGHT, NEEDS_YOU, beatOf } from "./view";
import { TONE } from "~/components/Signal";

describe("what a status means", () => {
  it("gives finished, blocked and broken three different colours", () => {
    expect(TONE.HandedBack).not.toBe(TONE.NeedsYou);
    expect(TONE.Failed).not.toBe(TONE.NeedsYou);
    expect(TONE.Failed).not.toBe(TONE.HandedBack);
  });

  it("spends ember on being blocked and on nothing else", () => {
    const ember = (Object.keys(TONE) as SessionStatus[]).filter((s) => TONE[s] === "text-ember");
    expect(ember).toEqual(["NeedsYou"]);
  });

  it("paints every status from the one table", () => {
    for (const status of Object.keys(BEAT) as SessionStatus[]) {
      expect(TONE[status]).toBe(BEAT_TONE[BEAT[status]]);
    }
  });

  it("still calls all three of them worth your attention", () => {
    // Attention and appearance are different questions; only the second moved.
    expect(NEEDS_YOU).toEqual(["NeedsYou", "HandedBack", "Failed"]);
    for (const status of NEEDS_YOU) expect(beatOf({ status })).not.toBe("working");
    for (const status of IN_FLIGHT) expect(beatOf({ status })).toBe("working");
  });
});
