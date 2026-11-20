/**
 * Where the right rail docks, and where it must not.
 *
 * **Measured on the pane, never on the window.** A configuration pane sits
 * with the 62pt rail and the 252px index beside it, so the window's width says
 * nothing about the room the pane has — and the one number this whole rule
 * exists for is a pane that is wide enough to look like it could take a
 * drawer and is not.
 *
 * The must-not is written down in the design: *nothing may dock a panel at
 * 669pt*. That is the Duo's inner portrait, which lays out at 607 once the
 * rail is off, and docking there would leave the screen 237 — narrower than
 * the drawer standing on it.
 */
import { describe, expect, test } from "vitest";
import {
  bandAt,
  DOCK_AT,
  FLOAT_AT,
  GRIP,
  RAIL_DEFAULT,
  RAIL_MIN,
  railCost,
  railWidth,
} from "./right-rail";

/** The pane, given a window: the rail is 62 and the index 252. */
const paneIn = (window: number) => window - 62 - 252;

describe("the bands", () => {
  test("the desk docks, and the screen keeps what the measurement said", () => {
    expect(paneIn(1296)).toBe(982);
    expect(bandAt(982)).toBe("dock");
    /* **370, and the screen keeps 612.** The design measured the drawer at
       368 plus a border; this spends the same 370 as 368 of rail and 2 of
       grip, so the number on the other side of it is the one that was
       published. A grip that cost three would quietly make it 611. */
    expect(railCost(RAIL_DEFAULT)).toBe(370);
    expect(982 - railCost(RAIL_DEFAULT)).toBe(612);
    expect(GRIP).toBe(2);
  });

  /**
   * **The must-not, as a test.** 669pt is the Duo's inner display in
   * portrait; off comes the 62pt rail and the pane is 607, which is the float
   * band. A change that moved `DOCK_AT` under 607 would dock there.
   */
  test("nothing docks at 669pt", () => {
    expect(669 - 62).toBe(607);
    expect(bandAt(607)).toBe("float");
    expect(bandAt(607)).not.toBe("dock");
  });

  test("each band begins where the one below it ends", () => {
    expect(bandAt(DOCK_AT)).toBe("dock");
    expect(bandAt(DOCK_AT - 1)).toBe("float");
    expect(bandAt(FLOAT_AT)).toBe("float");
    expect(bandAt(FLOAT_AT - 1)).toBe("push");
    expect(bandAt(0)).toBe("push");
  });
});

describe("how wide it may be", () => {
  test("it opens at the width the window's own rail opens at", () => {
    expect(railWidth(RAIL_DEFAULT, 982)).toBe(RAIL_DEFAULT);
  });

  /* 60% of the pane, which is `Workbench`'s rule against the thing the rail
     actually sits in. A rail refused the dock band that could still be
     dragged over most of what is left would make the band meaningless. */
  test("it is clamped at 60% of the pane, not of the window", () => {
    expect(railWidth(900, 982)).toBe(589);
    expect(railWidth(900, 1600)).toBe(900);
  });

  test("and never below the minimum, however little room there is", () => {
    expect(railWidth(100, 982)).toBe(RAIL_MIN);
    expect(railWidth(RAIL_DEFAULT, 200)).toBe(RAIL_MIN);
  });
});
