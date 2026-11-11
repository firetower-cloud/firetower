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
import {
  BLEED,
  GUTTER,
  LEDE_GUTTER,
  parseInsets,
  screenEdges,
  TOP_AIR,
  type Insets,
} from "~/ui/edges";

/** A plain phone: a status bar, a home indicator, nothing at the sides. */
const phone: Insets = { top: 59, bottom: 34, left: 0, right: 0 };

/** The Duo's front panel, as the system reports it — `right: 84`. */
const duo: Insets = { top: 59, bottom: 0, left: 0, right: 84 };

/** Android's usual report: the status bar's own height and nothing else. */
const android: Insets = { top: 24, bottom: 24, left: 0, right: 0 };

/**
 * The Duo's inner display, under the assumption the proposal is explicit
 * about: the clock sits over the trailing rail, outside the content, so the
 * content's own top inset is 0. The floor is written so the other answer —
 * an iPad-style 24 overlaid on the content — lands on the same number.
 */
const inner: Insets = { top: 0, bottom: 0, left: 0, right: 84 };

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
 * **The air above a screen's first line, which no device was guaranteeing.**
 *
 * `paddingTop` is `insets.top + (want.top ?? 0)` and every screen root passes
 * no `top` at all, so on a surface that reserves nothing the air was whatever
 * the header's own `pt-0.5` gave it — 2 pt. The floor is applied to the
 * resolved *total*, which is the whole reason it is not the `Math.max` the
 * file argues against: the regression test below is the one that matters.
 */
describe("the floor on the top", () => {
  it("gives a surface that reserves nothing the design's own air", () => {
    // The Duo's inner display, where the clock is over the rail and the
    // content's inset is 0. 2 pt of header air was all there was.
    expect(screenEdges(inner, { gutter: BLEED }).paddingTop).toBe(TOP_AIR);
    expect(screenEdges({ top: 0, bottom: 0, left: 0, right: 0 }).paddingTop).toBe(36);
  });

  it("does not become the padding on a notched phone — the regression", () => {
    // `Math.max(insets.top, want.top)` is the bug this file already argues
    // against. Floored on the total, 59 is still 59.
    expect(screenEdges(phone, { gutter: BLEED }).paddingTop).toBe(59);
    expect(screenEdges(duo, { gutter: BLEED }).paddingTop).toBe(59);
  });

  it("keeps the additive rule intact above the floor", () => {
    // A lede screen asks for 24 of its own. 59 + 24, not max(59, 24), and not
    // max(83, 36) landing anywhere but 83.
    expect(screenEdges(phone, { gutter: LEDE_GUTTER, top: 24 }).paddingTop).toBe(83);
    expect(screenEdges(phone, { top: 8, bottom: 24 }).paddingTop).toBe(67);
  });

  it("catches Android, which reports a status bar and nothing more", () => {
    // 24 + the header's 2 is 26 from the frame — the same defect one notch
    // smaller than the Duo's, and the reason the floor is not Duo-specific.
    expect(screenEdges(android, { gutter: BLEED }).paddingTop).toBe(36);
    // A design that asks for more still gets more.
    expect(screenEdges(android, { top: 24 }).paddingTop).toBe(48);
  });

  it("lands on the same number under either answer to the unmeasured inset", () => {
    // Nobody has read the inner display's top inset. 0 if the status bar
    // lives over the rail, 24 if iOS overlays an iPad-style bar on the
    // content. The floor is written so the proposal does not depend on it.
    for (const top of [0, 24, 36]) {
      expect(screenEdges({ ...inner, top }, { gutter: BLEED }).paddingTop).toBe(36);
    }
  });

  it("leaves the bottom alone, which is a decision and not an oversight", () => {
    // The composer sits on the keyboard, not on the home indicator. A
    // matching floor under it would hold air open once the keys are up.
    expect(screenEdges(inner, { gutter: BLEED }).paddingBottom).toBe(0);
    expect(screenEdges(android, { gutter: BLEED }).paddingBottom).toBe(24);
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

/**
 * **The supplied insets, which exist so the browser can reproduce a bug it
 * cannot otherwise have.**
 *
 * `env(safe-area-inset-*)` is `0px` in a browser, so the pre-fix code wrote 0
 * over a gutter that was already resolving against 0 and the defect was
 * invisible there by construction. Supplying the Duo's measured insets makes
 * the rule checkable at every width instead of only the one pose there is
 * hardware for.
 *
 * What is pinned here is the parsing, and specifically that it **refuses**
 * what it cannot read. A debug hook that half-reads its input is worse than
 * none: a sweep would report the gutter holding, or not holding, about an
 * injection that never happened.
 */
describe("insets supplied from a query string", () => {
  it("reads four numbers in CSS order", () => {
    // The Duo's front panel, as the system reports it.
    expect(parseInsets("?insets=0,84,34,0")).toEqual({ top: 0, right: 84, bottom: 34, left: 0 });
  });

  it("is absent unless asked for, which is every normal run", () => {
    expect(parseInsets("")).toBeNull();
    expect(parseInsets("?scene=team")).toBeNull();
  });

  it("tolerates spaces, because a URL typed by hand has them", () => {
    expect(parseInsets("?insets=59, 0, 34, 0")).toEqual({ top: 59, right: 0, bottom: 34, left: 0 });
  });

  it("survives other parameters beside it", () => {
    expect(parseInsets("?width=951&insets=0,84,34,0")).toEqual({
      top: 0,
      right: 84,
      bottom: 34,
      left: 0,
    });
  });

  it("refuses the wrong number of fields rather than guessing which is missing", () => {
    expect(parseInsets("?insets=0,84")).toBeNull();
    expect(parseInsets("?insets=0,84,34,0,12")).toBeNull();
  });

  it("refuses an empty field, which is a typo and not a zero", () => {
    // `Number("")` is 0, so this is the case a looser parse reads as valid.
    expect(parseInsets("?insets=0,,34,0")).toBeNull();
  });

  it("refuses units, negatives and words", () => {
    expect(parseInsets("?insets=0,84px,34,0")).toBeNull();
    expect(parseInsets("?insets=0,-84,34,0")).toBeNull();
    expect(parseInsets("?insets=top,right,bottom,left")).toBeNull();
    expect(parseInsets("?insets=0,Infinity,34,0")).toBeNull();
  });

  it("feeds the same rule as a real inset — the gutter still holds", () => {
    const duo = parseInsets("?insets=0,84,34,0")!;
    const pad = screenEdges(duo, { gutter: LEDE_GUTTER, top: 24, bottom: 24 });
    // What QA could not produce in a browser before: a non-zero inset on one
    // side, and 26 surviving on the other.
    expect(pad.paddingLeft).toBe(26);
    expect(pad.paddingRight).toBe(84);
  });
});
