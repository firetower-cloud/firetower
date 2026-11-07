import { describe, expect, test } from "vitest";
import { DOTTED, drawnInFull } from "./Home";

/**
 * The ember budget, which is the one rule on this screen that an eye cannot
 * check reliably and a count can.
 *
 * An earlier round of the design put six dots on the home and was rejected
 * for it. Three is the ceiling: at most two questions drawn in full, and the
 * rail's avatar for "waiting somewhere you are not".
 *
 * This pointed at `Dashboard`, which `Home` replaced. The rule came with it;
 * the test follows.
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

/* `also()` was here, naming the list under the questions — "Four others are
   still working". The home has two named sections instead, *Agents waiting
   for you* and *Recent artifacts*, so there is no heading to compose and
   nothing left to assert. Removed rather than left pointing at a function
   that no longer exists. */
