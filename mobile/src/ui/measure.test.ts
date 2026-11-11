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
  PANEL_MAX,
  panelWidth,
  posterColumns,
  READING_MAX,
} from "~/ui/measure";

/**
 * What the system reserves at the trailing edge, as the *documents* give it.
 *
 * Kept at 74 here because these tests are about the band arithmetic, which is
 * a pure function of two widths and does not care where the second one came
 * from. **The device says 84** — measured on the Duo's front panel, where the
 * system reports `right: 84` — so 74 is the documented figure rather than an
 * observed one, and `usePose` subtracts the real insets instead of this.
 */
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

  it("gives 951 the only column of any pose", () => {
    expect(panelWidth(content(POSES.innerl))).toBe(317);
    for (const id of ["iphone", "android", "front", "innerp"] as const) {
      expect(panelWidth(content(POSES[id]))).toBe(0);
    }
  });

  /**
   * **That column has been estimated three times and measured none.**
   *
   * | rail at 951 | laid out | column |
   * |---|---|---|
   * | 0 — what a browser reports | 951 | 340 |
   * | 74 — the documents' figure | 877 | 317 |
   * | 84 — what the *front panel* reports | 867 | 307 |
   *
   * The arithmetic is pinned here for all three. Which one is *true* is a
   * different question and still open: 84 was measured on the front panel,
   * and the front panel is `regular:false` in the prototype, so it says
   * nothing about what the inner display reserves. Nobody has read an inset
   * off that display.
   *
   * The trap worth naming: **the band classification is the same under all
   * three** — 951, 877 and 867 all dock — so a sweep run with a browser's own
   * zero insets reports every band correctly and a column of 340, for
   * something that is at most 317. A plausible number, arrived at honestly,
   * and wrong. Supplying the insets (`?insets=0,84,34,0`, see `edges.ts`) is
   * what makes the difference observable at a width no simulator here boots.
   */
  it("answers 340, 317 or 307 depending on a rail nobody has measured there", () => {
    expect(panelWidth(951)).toBe(340);
    expect(panelWidth(951 - 74)).toBe(317);
    expect(panelWidth(951 - 84)).toBe(307);
    // And every one of them docks, which is why the wrong one looks right.
    for (const laid of [951, 951 - 74, 951 - 84]) {
      expect(band(951, laid)).toBe("dock");
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

/**
 * **The two columns at 951, against the inset the system actually reported.**
 *
 * The block above keeps the documents' 74 because it is about the band
 * arithmetic, which does not care where the second width came from. This one
 * is about the *layout the home draws* at the one pose that docks on a Duo, so
 * it uses the measured 84 — and it asserts the **formula**, never the number
 * that falls out of it. `317` and `340` are both plausible answers arrived at
 * honestly from a rail nobody measured, and a test written against either
 * would pass while the screen was wrong. What has to hold is the relationship:
 * the conversation keeps its measure, the column takes the rest, and the two
 * of them plus the rail account for every point of the window.
 */
describe("the docked home's two columns, at the measured rail", () => {
  /** `right: 84`, as the system itself reports it. */
  const RAIL_MEASURED = 84;
  const WINDOW = 951;
  const content = WINDOW - RAIL_MEASURED;

  it("lays out in the frame less the rail, which is what `onLayout` reports", () => {
    // `pose.ts` measures the root's *frame* and subtracts the system insets.
    // A change that moves this number has broken the band arithmetic.
    expect(content).toBe(867);
    expect(docks(WINDOW, content)).toBe(true);
  });

  it("leaves the conversation exactly its measure, which is why the column is a remainder", () => {
    // `panelWidth` is `content − READING_MAX` rather than a breakpoint, so
    // this is an identity and not a coincidence at this one width.
    expect(conversationWidth(WINDOW, content)).toBe(READING_MAX);
    expect(content - panelWidth(content)).toBe(READING_MAX);
  });

  it("accounts for every point of the window: conversation, column, rail", () => {
    // The right column is drawn `panel + rail` wide with `marginRight: -rail`,
    // so its fill reaches the frame while its content stays inside the 84.
    const panel = panelWidth(content);
    expect(conversationWidth(WINDOW, content) + panel + RAIL_MEASURED).toBe(WINDOW);
    expect(panel + RAIL_MEASURED).toBeLessThanOrEqual(WINDOW - READING_MAX);
  });

  it("asks for a column it can fill, never the cap for its own sake", () => {
    expect(panelWidth(content)).toBe(Math.min(PANEL_MAX, content - READING_MAX));
    expect(panelWidth(content)).toBeGreaterThanOrEqual(DOCK_MIN);
  });
});

/**
 * **The one move the whole rule exists to stop, pinned against every rail
 * anybody has written down.**
 *
 * 669 is wider than a phone, so it invites a docked panel. Docking there
 * leaves the conversation less than the 390pt phone this design came from.
 * The band rule is not touched by the two-column home, the Workspaces
 * destination or the top-air floor, and this is the assertion that says so
 * under all three candidate insets rather than the one that happens to ship.
 */
describe("669 floats, whatever the rail turns out to be", () => {
  const RAILS = [0, 74, 84];

  it("never docks, at any inset anybody has proposed for that display", () => {
    for (const rail of RAILS) {
      const content = 669 - rail;
      expect(band(669, content)).toBe("float");
      expect(docks(669, content)).toBe(false);
      // Short of the dock line by more than a rounding error, not by points.
      expect(content).toBeLessThan(READING_MAX + DOCK_MIN);
    }
  });

  it("keeps the conversation the full width, because a float costs it nothing", () => {
    for (const rail of RAILS) {
      const content = 669 - rail;
      expect(conversationWidth(669, content)).toBe(content);
    }
  });
});

/**
 * **Two floors, asserted as floors rather than as a list of poses.**
 *
 * 390 is the phone this design came from and the band rule may never take the
 * conversation below it. 560 is `READING_MAX`, and a docked pose that does not
 * leave it has docked when it should have floated — which is what the old
 * `Math.min(340, Math.max(280, width - 400))` did, returning a 280pt column at
 * widths where 280 does not fit.
 *
 * **The 390 floor is about what the rule *spends*, not about what the hardware
 * hands over**, and the Duo's front panel is why that distinction has to be
 * written down. The system reserves 84 of a 466pt window, so the screen is
 * laid out in **382** — narrower than an iPhone, before any of this code runs.
 * No panel is taken from it, because `band(466, …)` is `push`. Asserting a
 * flat `>= 390` there would be asserting that the band rule can give width
 * back, which it cannot.
 *
 * The repository disagrees with itself about that pose and this is written to
 * hold either way: `edges.test.ts:19` pins the front panel's insets at
 * `right: 84` as the system reported them, while `coverage §2` models it as
 * `regular:false` and so never inset, at 466. Both are in the table below.
 * Nobody has measured which, the design is indifferent, and no band moves.
 */
describe("what the conversation is never left with", () => {
  /** Window, and the inset the system reports on it. */
  const POSES_MEASURED = [
    { what: "iPhone", window: 390, rail: 0 },
    { what: "Android", window: 412, rail: 0 },
    { what: "Duo front panel, as edges.test.ts pins it", window: 466, rail: 84 },
    { what: "Duo front panel, as coverage §2 models it", window: 466, rail: 0 },
    { what: "Duo inner portrait", window: 669, rail: 84 },
    { what: "Duo inner landscape", window: 951, rail: 84 },
    { what: "iPhone landscape", window: 844, rail: 0 },
  ];

  it("never spends width that would take the conversation below 390", () => {
    for (const p of POSES_MEASURED) {
      const content = p.window - p.rail;
      // Either the pose had 390 to give and the conversation still has it, or
      // it never had 390 and the rule took nothing. The front panel is the
      // second case: 382 laid out, and no panel to blame it on.
      expect(conversationWidth(p.window, content)).toBeGreaterThanOrEqual(Math.min(content, 390));
      if (content < 390) expect(conversationWidth(p.window, content)).toBe(content);
    }
  });

  it("leaves the front panel exactly what the system gave it, and takes nothing", () => {
    // 466 − 84. Narrower than an iPhone, and a fact about the hardware rather
    // than about this file: `band(466, 382)` is `push`, so there is no panel.
    expect(466 - 84).toBe(382);
    expect(band(466, 382)).toBe("push");
    expect(conversationWidth(466, 382)).toBe(382);
    expect(panelWidth(382)).toBe(0);
  });

  it("never drops below the reading measure in a pose that docks", () => {
    for (const p of POSES_MEASURED) {
      const content = p.window - p.rail;
      if (!docks(p.window, content)) continue;
      expect(conversationWidth(p.window, content)).toBeGreaterThanOrEqual(READING_MAX);
    }
  });

  it("holds both floors across every width, not just the five that ship", () => {
    // A sweep rather than a table: the rule is about widths, and the poses are
    // samples of it. 320 is the narrowest phone anybody still ships.
    for (let w = 320; w <= 1400; w++) {
      for (const rail of [0, 84]) {
        const content = Math.max(0, w - rail);
        const left = conversationWidth(w, content);
        if (docks(w, content)) {
          expect(left).toBeGreaterThanOrEqual(READING_MAX);
          expect(panelWidth(content)).toBeGreaterThanOrEqual(DOCK_MIN);
        }
        // A pose that does not dock spends nothing on a column.
        if (!docks(w, content)) expect(left).toBe(content);
      }
    }
  });
});
