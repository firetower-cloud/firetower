import { describe, expect, it } from "vitest";
import { place } from "./Annotate";
import { anchorIn } from "~/preview/anchor";

/**
 * Where the note card opens.
 *
 * The bug this pins down: the card used to hang off the *bottom edge of the
 * selection*, and the only clamp on it was a floor. Annotate a `<div>` two
 * screens tall — or drag a selection through half a file — and its bottom edge
 * is hundreds of pixels below the window, so the card opened where nothing
 * could be seen of it. It looked exactly like the card had not opened at all.
 *
 * So there are two invariants here, and the second one is the one that must
 * never bend: the card opens near the point you pointed at, and the card is
 * always entirely inside the window.
 */

const CARD = { width: 360, height: 150 };
const VIEW = { width: 1280, height: 900 };

/** A card is fully in the window, with its margin. */
function inside(box: { left: number; top: number }, card = CARD, view = VIEW) {
  return box.left >= 12 && box.top >= 12 && box.left + card.width <= view.width - 12 && box.top + card.height <= view.height - 12;
}

describe("where the card lands", () => {
  it("sits just under the point, centred on it", () => {
    expect(place({ x: 640, y: 400 }, CARD, VIEW)).toEqual({ side: "below", left: 460, top: 410 });
  });

  it("flips above the point when the window has no room under it", () => {
    const box = place({ x: 640, y: 850 }, CARD, VIEW);
    expect(box.side).toBe("above");
    expect(box.top).toBe(690);
    expect(inside(box)).toBe(true);
  });

  it("keeps a card whose point is far below the window on the screen", () => {
    // The screenshot case: an element taller than the preview, anchored at a
    // bottom edge 900px past the fold. Before, the card went with it.
    const box = place({ x: 640, y: 1800 }, CARD, VIEW);
    expect(inside(box)).toBe(true);
    expect(box.top).toBe(VIEW.height - CARD.height - 12);
  });

  it("stays in the window for any point at all, sane or not", () => {
    for (const x of [-4000, -1, 0, 7, 640, 1279, 1281, 9000])
      for (const y of [-4000, -1, 0, 7, 400, 899, 901, 9000]) expect(inside(place({ x, y }, CARD, VIEW))).toBe(true);
  });

  it("pins an oversized card to the top rather than letting it fall off the bottom", () => {
    // Nothing fits in a window this short. Losing the header and the quote is
    // survivable; losing the textarea and the keep button is not.
    expect(place({ x: 300, y: 80 }, CARD, { width: 600, height: 120 }).top).toBe(12);
  });

  it("holds the side it opened on and slides instead, when it is re-measured", () => {
    const first = place({ x: 640, y: 700 }, CARD, VIEW);
    expect(first.side).toBe("below");
    // Taller than it was — a font swapped in. It must not hop over the cursor.
    const grown = place({ x: 640, y: 700 }, { ...CARD, height: 240 }, VIEW, first.side);
    expect(grown.side).toBe("below");
    expect(grown.top).toBe(VIEW.height - 240 - 12);
    expect(inside(grown, { ...CARD, height: 240 })).toBe(true);
  });
});

describe("what a pick in the preview frame is anchored to", () => {
  const FRAME = { left: 350, top: 180, width: 930, height: 1100 };

  it("uses the click, because the click was on the screen", () => {
    expect(anchorIn(FRAME, [0, -600, 900, 2400], [420, 260])).toEqual({ x: 770, y: 440 });
  });

  it("falls back to as much of the element as the frame actually shows", () => {
    // A block from 600px above the fold to 1800px below it. Its own bottom
    // edge is unusable; the bottom of the *visible* part is not.
    expect(anchorIn(FRAME, [40, -600, 800, 2400])).toEqual({ x: 350 + 440, y: 180 + 1100 });
  });

  it("anchors to the real bottom edge when the element does fit", () => {
    expect(anchorIn(FRAME, [100, 200, 300, 150])).toEqual({ x: 350 + 250, y: 180 + 350 });
  });

  it("falls back to the middle of the frame when none of it is in view", () => {
    expect(anchorIn(FRAME, [40, 4000, 200, 100])).toEqual({ x: 350 + 465, y: 180 + 550 });
  });

  it("does not let the page put the card outside the frame", () => {
    // Everything here arrives over postMessage from an untrusted origin.
    expect(anchorIn(FRAME, [0, 0, 10, 10], [-9000, 9e9])).toEqual({ x: 350, y: 180 + 1100 });
  });
});
