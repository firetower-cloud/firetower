import { describe, expect, test } from "vitest";
import { also, drawnInFull } from "./Dashboard";

/**
 * The ember budget, which is the one rule on this screen that an eye cannot
 * check reliably and a count can.
 *
 * An earlier round of the design put six dots on the Dashboard and was
 * rejected for it. Three is the ceiling: at most two questions drawn in full,
 * and the rail's avatar for "waiting somewhere you are not".
 */
describe("how many questions get a dot", () => {
  const asks = (n: number) => Array.from({ length: n }, (_, i) => i);

  test("never more than two, however many are waiting", () => {
    for (let n = 0; n <= 12; n++) {
      expect(drawnInFull(asks(n)).inFull.length).toBeLessThanOrEqual(2);
    }
  });

  test("and nothing is dropped — what is not drawn in full is drawn quieter", () => {
    for (let n = 0; n <= 12; n++) {
      const { inFull, quieter } = drawnInFull(asks(n));
      expect([...inFull, ...quieter]).toEqual(asks(n));
    }
  });

  test("one or two waiting is the whole of it", () => {
    expect(drawnInFull(asks(1))).toEqual({ inFull: [0], quieter: [] });
    expect(drawnInFull(asks(2))).toEqual({ inFull: [0, 1], quieter: [] });
  });

  test("a third joins the list below rather than taking a third dot", () => {
    expect(drawnInFull(asks(3))).toEqual({ inFull: [0, 1], quieter: [2] });
  });
});

describe("what the list under the questions is called", () => {
  /* Nothing is asking: it is not "others", it is the list. */
  test("it is just Working when nothing is waiting", () => {
    expect(also(0, 0, 4)).toBe("Working");
    expect(also(0, 0, 0)).toBe("Working");
  });

  test("with questions above it, the rest are others", () => {
    expect(also(2, 0, 4)).toBe("Four others are still working");
    expect(also(2, 0, 1)).toBe("One other is still working");
  });

  /* "Still working" is a lie about a workspace that is waiting on you and did
     not fit the budget. The word has to change when one of those is in there. */
  test("and they are open, not working, once one of them is waiting", () => {
    expect(also(3, 1, 4)).toBe("Five others are still open");
  });
});
