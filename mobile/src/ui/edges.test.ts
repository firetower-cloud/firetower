/**
 * The rule a screen cannot be allowed to break: **an inset may only ever
 * increase padding.**
 *
 * This is the shape of a bug a user found rather than a hypothetical. Two
 * screens carried the design gutter on their root and then wrote the safe-area
 * inset over it, so on a device whose left inset is 0 the gutter became 0 and
 * the text sat against the frame. Asserted here against both insets that
 * exist on the one device with a rail — 0 and the measured 84.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BLEED, GUTTER, LEDE_GUTTER, screenEdges, type Insets } from "~/ui/edges";

/** A plain phone: a status bar, a home indicator, nothing at the sides. */
const phone: Insets = { top: 59, bottom: 34, left: 0, right: 0 };

/** The Duo's front panel, as the system reports it — `right: 84`. */
const duo: Insets = { top: 59, bottom: 0, left: 0, right: 84 };

describe("screen padding", () => {
  it("never falls below the gutter on either side, on either device", () => {
    for (const insets of [phone, duo]) {
      for (const gutter of [GUTTER, LEDE_GUTTER]) {
        const pad = screenEdges(insets, { gutter });
        expect(pad.paddingLeft).toBeGreaterThanOrEqual(gutter);
        expect(pad.paddingRight).toBeGreaterThanOrEqual(gutter);
      }
    }
  });

  /**
   * The regression itself. `locked.tsx` was
   * `{ paddingHorizontal: 24, paddingLeft: insets.left }` and rendered 0.
   */
  it("gives a lede screen its gutter where the shipped code gave it nothing", () => {
    const pad = screenEdges(duo, { gutter: LEDE_GUTTER, top: 24, bottom: 24 });
    expect(pad.paddingLeft).toBe(26);
    expect(pad.paddingLeft).not.toBe(duo.left);
  });

  it("lets the inset win when the hardware wants more than the design", () => {
    const pad = screenEdges(duo, { gutter: LEDE_GUTTER });
    // 84 of reserved rail already holds the content clear; 26 is only a floor.
    expect(pad.paddingRight).toBe(84);
  });

  it("yields exactly the inset when the children carry the gutter", () => {
    const pad = screenEdges(duo, { gutter: BLEED });
    // Which is what the thirteen full-bleed screens did before and still do —
    // the fix must not move them, or every row gains 20 it did not have.
    expect(pad.paddingLeft).toBe(0);
    expect(pad.paddingRight).toBe(84);
  });

  it("adds at the top and bottom rather than taking the larger", () => {
    const pad = screenEdges(phone, { top: 8, bottom: 24 });
    // `Math.max` here would put a title under the clock: max(59, 8) is 59,
    // which is the status bar's own height and no air at all.
    expect(pad.paddingTop).toBe(67);
    expect(pad.paddingBottom).toBe(58);
  });

  it("defaults to the gutter, so forgetting gives too much air and not none", () => {
    expect(screenEdges(phone).paddingLeft).toBe(GUTTER);
  });

  it("emits no shorthand for a longhand to defeat", () => {
    const pad = screenEdges(phone, { gutter: GUTTER });
    expect(pad).not.toHaveProperty("paddingHorizontal");
    expect(pad).not.toHaveProperty("paddingVertical");
    expect(Object.keys(pad).sort()).toEqual([
      "paddingBottom",
      "paddingLeft",
      "paddingRight",
      "paddingTop",
    ]);
  });

  it("keeps 24 out of it — that number is in neither of the drawing's gutters", () => {
    // The shipped code's 24 is `.p-springboard`'s, which draws the iOS home
    // screen, and `.d-stage`'s, which is the document's chrome. Not the app's.
    expect(GUTTER).toBe(20);
    expect(LEDE_GUTTER).toBe(26);
  });
});

/**
 * **And the arithmetic being right is not the fix.**
 *
 * `screenEdges` being correct says nothing about whether fifteen screen roots
 * call it. The bug was never in a calculation — it was a pattern copied across
 * a directory, and the thing worth pinning is that the pattern is gone.
 *
 * So this reads the source. Not a model of it, not a snapshot: the files
 * themselves, which is the only level at which "no screen does this any more"
 * is a claim rather than a hope.
 */
describe("no screen replaces its gutter with an inset", () => {
  const roots = readdirSync(new URL("../../app", import.meta.url), {
    recursive: true,
    encoding: "utf8",
  }).filter((f) => f.endsWith(".tsx"));

  /**
   * `pose.ts` subtracts the **system** inset from a measured frame to get the
   * band's laid-out width, which is a different question and must keep reading
   * them. `Sheet` and `Picker` set margins on a floating surface rather than a
   * screen's padding. `edges.ts` is the rule itself.
   */
  it("reads them nowhere in app/ — only in edges.ts, pose.ts, Sheet and Picker", () => {
    const offenders = roots.filter((f) => {
      const src = readFileSync(new URL(`../../app/${f}`, import.meta.url), "utf8");
      return /padding(?:Left|Right|Horizontal)\s*:\s*insets\./.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it("finds every screen root going through the hook instead", () => {
    const using = roots.filter((f) =>
      readFileSync(new URL(`../../app/${f}`, import.meta.url), "utf8").includes("useEdges("),
    );
    // Thirteen full-bleed screens and the two lede ones. If a screen is added
    // without it, this is the number that moves.
    expect(using.length).toBeGreaterThanOrEqual(15);
  });
});
