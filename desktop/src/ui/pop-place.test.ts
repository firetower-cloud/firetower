import { describe, expect, it } from "vitest";
import { fromInside, place } from "./Pop";

/**
 * The two things a portalled menu has to get right, both reported as the same
 * bug — "when I try to scroll it it stops".
 *
 * **Scrolling it must not close it.** The listener that closes on an ancestor
 * scroll has to capture at the window, because `scroll` does not bubble, and
 * capturing hears the menu's own list as well. Telling the two apart is the
 * whole fix, and the case that broke was the commonest gesture there is.
 *
 * **It must be entirely on screen.** The repository menu flipped above its
 * pill and ran off the top of the window, with nothing capping its height —
 * so the rows past the edge could not be reached at all. Flipping alone does
 * not fix that; the cap is what fixes it.
 */

const VIEW = { width: 1280, height: 900 };
/** The repository pill on the New page, roughly where the composer puts it. */
const PILL = { top: 420, bottom: 448, right: 700 };
/** A menu with more rows than its `max-h-80` shows. */
const TALL = { width: 340, height: 320 };

/** A card is inside the window, with its 8px margin, at the height it was given. */
function inside(spot: ReturnType<typeof place>, view = VIEW) {
  const top = spot.top ?? view.height - spot.bottom! - spot.room;
  return top >= 8 && top + spot.room <= view.height - 8;
}

describe("where the menu lands", () => {
  it("drops below the button, right-aligned to it, when there is room", () => {
    expect(place(PILL, TALL, VIEW)).toEqual({ left: 360, top: 452, room: 440 });
  });

  it("flips above when it does not fit below and above is roomier", () => {
    // 200px of window under the pill, 420 over it.
    const spot = place(PILL, TALL, { width: 1280, height: 648 });
    expect(spot.top).toBeUndefined();
    // Anchored by its bottom edge, four pixels clear of the pill's top.
    expect(spot.bottom).toBe(648 - 420 + 4);
    expect(spot.room).toBe(408);
  });

  it("keeps dropping downward while it fits, even with more room above", () => {
    // The pill low on a tall window: 330px below is still enough for 320.
    const low = { top: 540, bottom: 558, right: 700 };
    expect(place(low, TALL, VIEW).top).toBe(562);
  });

  it("caps its height to the room it has, rather than running off the top", () => {
    // The reported screenshot: a short window, the menu flipped, and seven
    // repositories where only four fit. Before the cap the card kept its full
    // height and its top edge went negative.
    const spot = place({ top: 260, bottom: 288, right: 700 }, TALL, { width: 1000, height: 420 });
    expect(spot.room).toBeLessThan(TALL.height);
    expect(inside(spot, { width: 1000, height: 420 })).toBe(true);
  });

  it("is on screen whichever way it goes, at every height the window can be", () => {
    for (let height = 320; height <= 1000; height += 20) {
      for (let top = 8; top + 28 <= height - 8; top += 20) {
        const spot = place({ top, bottom: top + 28, right: 700 }, TALL, { width: 1000, height });
        expect(inside(spot, { width: 1000, height })).toBe(true);
      }
    }
  });

  it("never leaves the left edge of the window, for a menu wider than its button", () => {
    expect(place({ top: 100, bottom: 128, right: 120 }, TALL, VIEW).left).toBe(8);
  });
});

describe("telling the menu's own scrolling from an ancestor's", () => {
  /** Enough of a node to be asked about: `nodeType` is what the guard reads. */
  const node = (nodeType = 1) => ({ nodeType }) as unknown as Node;
  const list = node();
  const elsewhere = node();
  const menu = { contains: (n: Node) => n === list } as unknown as Node;

  it("knows the list inside it, which must not close it", () => {
    expect(fromInside(list, menu)).toBe(true);
  });

  it("knows a scroller outside it, which must close it", () => {
    expect(fromInside(elsewhere, menu)).toBe(false);
  });

  it("treats the page scrolling as outside — the target is the document", () => {
    // A `Document` is a node (type 9) and an ancestor, so `contains` says no.
    expect(fromInside(node(9), menu)).toBe(false);
  });

  it("treats a target that is not a node as outside", () => {
    // The guard earns its keep here: `contains` would throw on either.
    expect(fromInside({} as EventTarget, menu)).toBe(false);
    expect(fromInside(null, menu)).toBe(false);
  });

  it("is outside when the menu has already gone", () => {
    expect(fromInside(list, null)).toBe(false);
  });
});
