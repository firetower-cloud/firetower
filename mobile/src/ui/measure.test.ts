/**
 * The bands, which are the design rather than a breakpoint.
 *
 * Every number here is load-bearing and three of them are traps, so each one
 * gets a test that would fail if somebody reached for the obvious wrong
 * answer. The `820` case is here specifically because it is the number written
 * in the older documents and the one a reader will try.
 */
import { describe, expect, it } from "vitest";
import {
  band,
  conversationWidth,
  DOCK_MIN,
  docks,
  dottedChips,
  floatWidth,
  libraryColumns,
  panelWidth,
  posterColumns,
  READING_MAX,
} from "~/ui/measure";

/** The system's trailing tab rail on the inner display. */
const RAIL = 74;

/** The five poses, at their real widths. */
const POSES = {
  iphone: { w: 390, rail: 0 },
  android: { w: 412, rail: 0 },
  front: { w: 466, rail: 0 },
  innerp: { w: 669, rail: RAIL },
  innerl: { w: 951, rail: RAIL },
} as const;

const content = (p: { w: number; rail: number }) => p.w - p.rail;
const bandOf = (p: { w: number; rail: number }) => band(p.w, content(p));

describe("the three bands", () => {
  it("pushes under 600 and floats from 600", () => {
    expect(band(599)).toBe("push");
    expect(band(600)).toBe("float");
  });

  it("docks from 840 of laid-out width, which is a 914 window with the rail", () => {
    expect(band(913, 913 - RAIL)).toBe("float");
    expect(band(914, 914 - RAIL)).toBe("dock");
    // The same question with no rail: the content *is* the window.
    expect(band(839, 839)).toBe("float");
    expect(band(840, 840)).toBe("dock");
    expect(READING_MAX + DOCK_MIN).toBe(840);
  });

  it("does not dock at 820, which is the number the documents get wrong", () => {
    // 820 is the dock line answered against the window instead of the box.
    expect(band(820, 820 - RAIL)).toBe("float");
    // And even with no rail at all it is 20 short of the real line.
    expect(band(820, 820)).toBe("float");
  });

  it("asks the push question of the window and the dock question of the box", () => {
    // 669 lays out in 595. Asking push against the content would flip it to
    // push by five points, which contradicts the rule the band serves.
    expect(content(POSES.innerp)).toBe(595);
    expect(bandOf(POSES.innerp)).toBe("float");
  });
});

describe("the five poses", () => {
  it("puts each in the band the drawing gives it", () => {
    expect(bandOf(POSES.iphone)).toBe("push");
    expect(bandOf(POSES.android)).toBe("push");
    expect(bandOf(POSES.front)).toBe("push");
    expect(bandOf(POSES.innerp)).toBe("float");
    expect(bandOf(POSES.innerl)).toBe("dock");
  });

  it("gives 951 a 317pt column, and it is the only pose with one", () => {
    expect(panelWidth(content(POSES.innerl))).toBe(317);
    for (const id of ["iphone", "android", "front", "innerp"] as const) {
      expect(panelWidth(content(POSES[id]))).toBe(0);
    }
  });

  it("never docks at 669 — the one move the whole rule exists to stop", () => {
    expect(docks(669, 595)).toBe(false);
    // Docking there would leave the conversation 329, or 255 with the rail.
    expect(669 - 340).toBe(329);
    expect(595 - 340).toBe(255);
  });

  it("never leaves the conversation below 390 on any pose", () => {
    for (const id of ["iphone", "android", "front", "innerp", "innerl"] as const) {
      const p = POSES[id];
      expect(conversationWidth(p.w, content(p))).toBeGreaterThanOrEqual(390);
    }
  });

  it("leaves the conversation its measure wherever it docks", () => {
    for (let w = 914; w <= 2000; w++) {
      const c = w - RAIL;
      if (!docks(w, c)) continue;
      expect(conversationWidth(w, c)).toBeGreaterThanOrEqual(READING_MAX);
    }
  });
});

describe("the rotated phone, which the drawing never drew", () => {
  /**
   * Unlocking `orientation` is what makes the dock band reachable at all, and
   * it also gives a plain iPhone a landscape pose at **844 × 390** that the
   * design never drew. The rule answers it without a new decision, and the
   * answer is **dock**, not float: a plain iPhone is compact width in
   * landscape so nothing insets it, 844 clears the 840 line, and the column
   * gets 284 while the conversation keeps exactly its 560 measure.
   *
   * That is the band rule working, not a special case — but it is worth
   * pinning, because "914" is the dock threshold *for the Duo* and reading it
   * as a universal window threshold puts this pose in the wrong band. 914 is
   * 840 plus the inner display's 74 pt rail; a surface with no rail docks at
   * 840.
   *
   * **The width is fine and the height is the open question.** 390 pt of
   * height with a 291 pt keyboard up leaves 99, and nothing has measured what
   * that does to a docked two-pane layout. Reported rather than designed
   * around — see the hand-back.
   */
  it("docks at 844 by the rule, because nothing insets a compact phone", () => {
    expect(band(844, 844)).toBe("dock");
    expect(docks(844, 844)).toBe(true);
    expect(panelWidth(844)).toBe(284);
    expect(conversationWidth(844, 844)).toBe(560);
    expect(conversationWidth(844, 844)).toBe(READING_MAX);
  });

  it("would float at 844 if something did inset it, and still keep the measure", () => {
    expect(band(844, 844 - RAIL)).toBe("float");
    expect(conversationWidth(844, 844 - RAIL)).toBe(770);
  });

  it("docks the rotated Android baseline, at the 340 cap", () => {
    expect(band(915, 915)).toBe("dock");
    expect(panelWidth(915)).toBe(340);
    expect(conversationWidth(915, 915)).toBe(575);
  });
});

describe("what a panel takes", () => {
  it("returns nothing rather than a strip it cannot fill", () => {
    expect(panelWidth(READING_MAX + DOCK_MIN - 1)).toBe(0);
    expect(panelWidth(READING_MAX + DOCK_MIN)).toBe(DOCK_MIN);
  });

  it("caps at 340 however much room there is", () => {
    expect(panelWidth(5000)).toBe(340);
    expect(floatWidth(5000)).toBe(340);
  });

  it("never returns a negative float width on a narrow box", () => {
    expect(floatWidth(40)).toBe(0);
  });
});

describe("grids and chips", () => {
  it("gives two posters at 390 and three at 595", () => {
    expect(posterColumns(390, false)).toBe(2);
    expect(posterColumns(466, false)).toBe(2);
    expect(posterColumns(572, false)).toBe(2);
    expect(posterColumns(573, false)).toBe(3);
    expect(posterColumns(595, false)).toBe(3);
  });

  it("keeps two in a docked pose, because three in 340 would be 89 wide", () => {
    expect(posterColumns(877, true)).toBe(2);
  });

  it("gives the library three from 620", () => {
    expect(libraryColumns(619)).toBe(2);
    expect(libraryColumns(620)).toBe(3);
  });

  it("dots one chip until the second one would actually read", () => {
    expect(dottedChips(390)).toBe(1);
    expect(dottedChips(466)).toBe(1);
    expect(dottedChips(576)).toBe(1);
    expect(dottedChips(577)).toBe(2);
    expect(dottedChips(595)).toBe(2);
  });
});
