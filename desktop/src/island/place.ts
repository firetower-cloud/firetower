/**
 * Where the pill goes.
 *
 * All of it is arithmetic on rectangles, and that is deliberate: placement is
 * the part of the island most likely to be wrong — off by a menu bar, on a
 * display that was unplugged, half over the edge of a screen that is not the
 * one it was remembered on — and it is the part hardest to check by looking,
 * because reproducing it means owning three monitors and pulling a cable out.
 *
 * So `island.rs` reports geometry and this file decides, which puts every
 * decision in reach of `place.test.ts`.
 *
 * One coordinate system throughout: logical points, origin at the top-left of
 * the primary display, y growing downward. That is what `island_place` takes,
 * and the Rust has already converted AppKit's bottom-left origin away.
 */

/** A display, as `island_screens` reports it. */
export type Screen = {
  name: string;
  primary: boolean;
  /** The whole display. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** The part left over after the menu bar and the Dock. */
  workX: number;
  workY: number;
  workWidth: number;
  workHeight: number;
  /** Zero on a display without one. */
  notchWidth: number;
  notchHeight: number;
};

export type Size = { width: number; height: number };
export type Rect = { x: number; y: number; width: number; height: number };

/** Docked into the notch, or floating anywhere else. */
export type Mode = "notch" | "float";

/** What is remembered between launches. */
export type Perch = { screen: string; mode: Mode; x: number; y: number };

/** A perch resolved against the displays that actually exist right now. */
export type Placed = { screen: Screen; mode: Mode; rect: Rect };

/** Between the menu bar and a floating pill. */
export const GAP = 6;
/** How near the notch a drag has to finish before the pill is pulled in. */
export const MAGNET = 90;
/** Never closer than this to an edge, so the pill is never half off. */
export const MARGIN = 4;

export const notched = (s: Screen) => s.notchHeight > 0 && s.notchWidth > 0;

export const perchOf = (p: Placed): Perch => ({
  screen: p.screen.name,
  mode: p.mode,
  x: p.rect.x,
  y: p.rect.y,
});

/** The display with the menu bar on it. */
export function primaryOf(screens: Screen[]): Screen | null {
  return screens.find((s) => s.primary) ?? screens[0] ?? null;
}

/**
 * Which display a rectangle is on.
 *
 * By its centre, not its origin: a pill straddling two monitors belongs to the
 * one you can see most of it on, and dragging it across the seam should hand
 * it over once, at the halfway point, rather than the moment its left edge
 * crosses.
 */
export function screenFor(rect: Rect, screens: Screen[]): Screen | null {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const holding = screens.find(
    (s) => cx >= s.x && cx < s.x + s.width && cy >= s.y && cy < s.y + s.height,
  );
  if (holding) return holding;

  // The centre is in the gap between two displays, or off every one of them
  // — which happens the instant a monitor is unplugged. Nearest wins.
  let best: Screen | null = null;
  let closest = Infinity;
  for (const s of screens) {
    const dx = Math.max(s.x - cx, 0, cx - (s.x + s.width));
    const dy = Math.max(s.y - cy, 0, cy - (s.y + s.height));
    const d = dx * dx + dy * dy;
    if (d < closest) {
      closest = d;
      best = s;
    }
  }
  return best;
}

/* Both of these take a `Size`, and callers pass a `Rect` — which is a `Size`
   with an origin on it. So the width and the height are read out by name
   rather than spread: `{ x, y, ...size }` puts the *old* origin back over the
   one just computed, and a docked pill silently stays exactly where the drag
   left it. */

/** Centred on the notch, flush with the top edge, so the two read as one shape. */
export function dock(screen: Screen, size: Size): Rect {
  return {
    x: Math.round(screen.x + (screen.width - size.width) / 2),
    y: screen.y,
    width: size.width,
    height: size.height,
  };
}

/** Centred under the menu bar, floating clear of it. */
export function floating(screen: Screen, size: Size): Rect {
  return {
    x: Math.round(screen.workX + (screen.workWidth - size.width) / 2),
    y: Math.round(screen.workY + GAP),
    width: size.width,
    height: size.height,
  };
}

/**
 * Pull a rectangle fully onto a display.
 *
 * The top edge is allowed to be the top of the *frame* rather than the top of
 * the work area, because the island is a thing that sits over the menu bar on
 * purpose. Every other edge respects a margin.
 */
export function clampTo(screen: Screen, rect: Rect): Rect {
  const wide = rect.width >= screen.width - MARGIN * 2;
  const tall = rect.height >= screen.height - MARGIN;
  return {
    ...rect,
    x: wide
      ? Math.round(screen.x + (screen.width - rect.width) / 2)
      : Math.min(
          Math.max(rect.x, screen.x + MARGIN),
          screen.x + screen.width - rect.width - MARGIN,
        ),
    y: tall
      ? screen.y
      : Math.min(Math.max(rect.y, screen.y), screen.y + screen.height - rect.height - MARGIN),
  };
}

/** Where a fresh install puts it: in the notch if there is one, under the menu bar if not. */
export function defaultPlacement(screens: Screen[], size: Size): Placed | null {
  const screen = primaryOf(screens);
  if (!screen) return null;
  return notched(screen)
    ? { screen, mode: "notch", rect: dock(screen, size) }
    : { screen, mode: "float", rect: floating(screen, size) };
}

/**
 * A remembered perch, against the displays that are here now.
 *
 * Three things can have changed since it was written: the display is gone, the
 * display is still here but a different size, or it is the same display and the
 * pill is a different size because the fleet is. The first falls back, and the
 * other two are handled by recomputing rather than trusting the stored point —
 * which is why a docked island is never restored from coordinates.
 */
export function resolve(saved: Perch | null, screens: Screen[], size: Size): Placed | null {
  if (!saved) return defaultPlacement(screens, size);

  const screen = screens.find((s) => s.name === saved.screen);
  if (!screen) return defaultPlacement(screens, size);

  // The notch is a place, not a coordinate. Recompute it: the pill's width
  // changes with the fleet, and a stored x would leave it off-centre.
  if (saved.mode === "notch") {
    return notched(screen)
      ? { screen, mode: "notch", rect: dock(screen, size) }
      : // Same display name, no notch any more — a different monitor wearing a
        // familiar label. Degrade to floating rather than to nothing.
        { screen, mode: "float", rect: floating(screen, size) };
  }

  return {
    screen,
    mode: "float",
    rect: clampTo(screen, { x: saved.x, y: saved.y, width: size.width, height: size.height }),
  };
}

/**
 * Where a drag ends up.
 *
 * The notch is magnetic: finish near it and the pill is taken in rather than
 * left a few pixels off, because "nearly docked" looks like a mistake and
 * cannot be corrected by hand at this size.
 */
export function snap(rect: Rect, screens: Screen[]): Placed | null {
  const screen = screenFor(rect, screens);
  if (!screen) return null;

  if (notched(screen)) {
    const pull = Math.abs(rect.x + rect.width / 2 - (screen.x + screen.width / 2));
    if (pull <= MAGNET && rect.y <= screen.y + MAGNET) {
      return { screen, mode: "notch", rect: dock(screen, rect) };
    }
  }
  return { screen, mode: "float", rect: clampTo(screen, rect) };
}

/**
 * The expanded panel, from the collapsed pill it grew out of.
 *
 * Grows downward and keeps its centre, so the pill does not appear to jump
 * sideways as it opens. If there is no room below — the pill has been dragged
 * near the bottom of a display — it grows upward instead, which is the one
 * case where the thing you were pointing at moves, and still better than a
 * panel running off the screen.
 */
export function grow(from: Rect, to: Size, screen: Screen): Rect {
  const centre = from.x + from.width / 2;
  const below = screen.y + screen.height - MARGIN - (from.y + to.height);
  const y = below >= 0 ? from.y : from.y + from.height - to.height;
  return clampTo(screen, {
    x: Math.round(centre - to.width / 2),
    y: Math.round(y),
    width: to.width,
    height: to.height,
  });
}

/**
 * Whether the displays have changed under us.
 *
 * Cheaper than an AppKit notification observer and, for a pill that is
 * re-placed on every fleet poll anyway, no less correct: the only thing this
 * has to catch is a monitor arriving or leaving between polls.
 */
export function fingerprint(screens: Screen[]): string {
  return screens
    .map((s) => [s.name, s.x, s.y, s.width, s.height, s.notchHeight].join(":"))
    .join("|");
}
