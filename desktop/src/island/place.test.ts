/**
 * Where the pill goes, asked the questions a desk can't be made to ask.
 *
 * Every bug this file is here for needs hardware to reproduce: a second
 * monitor to the left with a negative origin, a laptop lid closed so the
 * notched display is gone, a dock that moved and shrank the work area. None of
 * that is reachable by running the app and looking at it, which is the whole
 * reason placement is arithmetic in a module of its own rather than a few
 * lines inside a `useEffect`.
 */
import { describe, expect, it } from "vitest";
import {
  clampTo,
  defaultPlacement,
  fingerprint,
  grow,
  resolve,
  screenFor,
  snap,
  type Perch,
  type Screen,
  type Size,
} from "./place";

/** A 16-inch MacBook Pro: notched, primary, origin at zero. */
const laptop: Screen = {
  name: "Built-in Retina Display",
  primary: true,
  x: 0,
  y: 0,
  width: 1728,
  height: 1117,
  workX: 0,
  workY: 38,
  workWidth: 1728,
  workHeight: 1017,
  notchWidth: 200,
  notchHeight: 38,
};

/** The same panel with the notch filled in — an Air, or an older Pro. */
const flat: Screen = { ...laptop, name: "Built-in Display", notchWidth: 0, notchHeight: 0, workY: 25 };

/** A display to the *left*, which is where the negative coordinates come from. */
const external: Screen = {
  name: "LG UltraFine",
  primary: false,
  x: -2560,
  y: 0,
  width: 2560,
  height: 1440,
  workX: -2560,
  workY: 25,
  workWidth: 2560,
  workHeight: 1415,
  notchWidth: 0,
  notchHeight: 0,
};

const pill: Size = { width: 200, height: 28 };
const panel: Size = { width: 364, height: 220 };

describe("where a fresh install puts it", () => {
  it("docks into the notch, centred and flush with the top", () => {
    const placed = defaultPlacement([laptop, external], pill);
    expect(placed?.mode).toBe("notch");
    expect(placed?.rect).toMatchObject({ x: (1728 - 200) / 2, y: 0 });
  });

  it("floats under the menu bar when the display has no notch", () => {
    const placed = defaultPlacement([flat], pill);
    expect(placed?.mode).toBe("float");
    // Clear of the menu bar, not over it: with no notch to hide in, a pill
    // sitting on top of the menus is covering something.
    expect(placed?.rect.y).toBe(flat.workY + 6);
  });

  it("uses the display with the menu bar, not the first one listed", () => {
    expect(defaultPlacement([external, laptop], pill)?.screen.name).toBe(laptop.name);
  });

  it("has nowhere to go with no displays at all", () => {
    expect(defaultPlacement([], pill)).toBeNull();
  });
});

describe("a perch remembered from last time", () => {
  it("is honoured when the display is still there", () => {
    const saved: Perch = { screen: external.name, mode: "float", x: -1800, y: 120 };
    const placed = resolve(saved, [laptop, external], pill);
    expect(placed?.screen.name).toBe(external.name);
    expect(placed?.rect).toMatchObject({ x: -1800, y: 120 });
  });

  /* The lid is shut, or the cable is out. The island has to be somewhere, and
     somewhere invisible is the one answer that is wrong. */
  it("falls back to the default when that display is gone", () => {
    const saved: Perch = { screen: external.name, mode: "float", x: -1800, y: 120 };
    const placed = resolve(saved, [laptop], pill);
    expect(placed?.screen.name).toBe(laptop.name);
    expect(placed?.mode).toBe("notch");
  });

  /* The notch is a place, not a coordinate. Restoring a docked island from a
     stored x leaves it off-centre the moment the fleet changes the pill's
     width — which is every time a session starts. */
  it("re-centres a docked pill instead of trusting the stored x", () => {
    const saved: Perch = { screen: laptop.name, mode: "notch", x: 764, y: 0 };
    const wider = resolve(saved, [laptop], { width: 320, height: 28 });
    expect(wider?.rect.x).toBe((1728 - 320) / 2);
  });

  /* Same name, no notch: a different monitor wearing a familiar label, or a
     display that was replaced. Better floating than nowhere. */
  it("degrades a docked perch to floating if the notch has gone", () => {
    const saved: Perch = { screen: flat.name, mode: "notch", x: 764, y: 0 };
    expect(resolve(saved, [flat], pill)?.mode).toBe("float");
  });

  it("pulls a perch that is now off the edge back onto the display", () => {
    const saved: Perch = { screen: laptop.name, mode: "float", x: 1700, y: 200 };
    const placed = resolve(saved, [laptop], pill);
    expect(placed?.rect.x).toBe(1728 - 200 - 4);
  });
});

describe("where a drag ends up", () => {
  it("is pulled into the notch when it finishes near it", () => {
    const landed = snap({ x: 700, y: 10, ...pill }, [laptop]);
    expect(landed?.mode).toBe("notch");
    expect(landed?.rect).toMatchObject({ x: (1728 - 200) / 2, y: 0 });
  });

  it("is left alone when it finishes away from the notch", () => {
    const landed = snap({ x: 1200, y: 10, ...pill }, [laptop]);
    expect(landed?.mode).toBe("float");
    expect(landed?.rect.x).toBe(1200);
  });

  /* Directly under the notch but halfway down the screen is a deliberate
     placement, not a near miss. Magnetism that reaches that far is a pill you
     cannot put where you want it. */
  it("is left alone when it is below the notch rather than at it", () => {
    expect(snap({ x: 764, y: 400, ...pill }, [laptop])?.mode).toBe("float");
  });

  it("belongs to the display holding its centre, not its left edge", () => {
    // Straddling the seam, mostly on the external one.
    const landed = snap({ x: -120, y: 300, ...pill }, [laptop, external]);
    expect(landed?.screen.name).toBe(external.name);
  });

  it("never leaves it hanging off an edge", () => {
    const landed = snap({ x: 1720, y: 1110, ...pill }, [laptop]);
    expect(landed!.rect.x + pill.width).toBeLessThanOrEqual(1728);
    expect(landed!.rect.y + pill.height).toBeLessThanOrEqual(1117);
  });

  it("has nowhere to land with no displays", () => {
    expect(snap({ x: 0, y: 0, ...pill }, [])).toBeNull();
  });
});

describe("which display a rectangle is on", () => {
  /* The instant a monitor is unplugged every remembered coordinate points at
     empty space, and "no screen" would mean the island stops being placed at
     all — invisible, and impossible to get back without clearing storage. */
  it("is the nearest one when the centre is on none of them", () => {
    expect(screenFor({ x: 9000, y: 9000, ...pill }, [laptop, external])?.name).toBe(laptop.name);
  });

  it("is none when there are none", () => {
    expect(screenFor({ x: 0, y: 0, ...pill }, [])).toBeNull();
  });
});

describe("opening the panel", () => {
  const from = { x: 764, y: 0, ...pill };

  it("keeps the centre, so it does not appear to jump sideways", () => {
    const grown = grow(from, panel, laptop);
    expect(grown.x + panel.width / 2).toBe(from.x + from.width / 2);
  });

  it("grows downward when there is room", () => {
    expect(grow(from, panel, laptop).y).toBe(0);
  });

  /* Dragged near the bottom of a display, a panel that grows down runs off it.
     This is the one case where the thing being pointed at moves, and it is
     still the better of the two. */
  it("grows upward when there is not", () => {
    const low = { x: 764, y: 1050, ...pill };
    const grown = grow(low, panel, laptop);
    expect(grown.y).toBeLessThan(low.y);
    expect(grown.y + panel.height).toBeLessThanOrEqual(1117);
  });

  it("stays on the display when the pill was near an edge", () => {
    const edge = { x: 1520, y: 0, ...pill };
    const grown = grow(edge, panel, laptop);
    expect(grown.x + panel.width).toBeLessThanOrEqual(1728);
  });
});

describe("clamping", () => {
  /* The top of the *frame*, not the top of the work area: sitting over the
     menu bar is the point of the thing, and clamping to `workY` would quietly
     make docking impossible. */
  it("allows the top edge of the display", () => {
    expect(clampTo(laptop, { x: 700, y: 0, ...pill }).y).toBe(0);
  });

  it("centres anything wider than the display rather than pinning it left", () => {
    const huge = { x: 0, y: 0, width: 3000, height: 28 };
    expect(clampTo(laptop, huge).x).toBe((1728 - 3000) / 2);
  });
});

describe("noticing the displays changed", () => {
  it("is unchanged by asking twice", () => {
    expect(fingerprint([laptop, external])).toBe(fingerprint([laptop, external]));
  });

  it("changes when a monitor arrives", () => {
    expect(fingerprint([laptop])).not.toBe(fingerprint([laptop, external]));
  });

  /* Closing the lid on a MacBook attached to a display keeps the name and
     loses the notch, and the pill has to be re-placed for it. */
  it("changes when a display keeps its name but loses its notch", () => {
    expect(fingerprint([laptop])).not.toBe(fingerprint([{ ...laptop, notchHeight: 0 }]));
  });
});
