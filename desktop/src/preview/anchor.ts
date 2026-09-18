/**
 * Where a note card belongs when the thing it is about lives in the preview
 * frame.
 *
 * The frame is another origin, so everything here arrives as numbers from the
 * picker: the element's rectangle in the *page's* viewport, and — when a
 * pointer chose it — the point it was clicked at. Both have to be carried into
 * this window's coordinates, and neither may be trusted to be on screen.
 */

/** Into the frame, from either end. The page is not trusted to send a sane number. */
const within = (value: number, high: number) => Math.max(0, Math.min(value, high));

export type Frame = { left: number; top: number; width: number; height: number };

/**
 * The click, when there was one: it is somewhere visible by definition, and it
 * is where you were already looking.
 *
 * Without one — a keypress in the page, or the panel's own step to the parent
 * element — the middle of the bottom edge of *as much of the element as the
 * frame shows*. A block taller than the preview has its real bottom edge some
 * way below the desk, and a card hung off that edge is a card nobody can see.
 */
export function anchorIn(frame: Frame, bounds: number[], point?: [number, number]): { x: number; y: number } {
  const here = (x: number, y: number) => ({ x: frame.left + within(x, frame.width), y: frame.top + within(y, frame.height) });
  if (point) return here(point[0], point[1]);
  const [x, y, width, height] = bounds;
  const left = Math.max(x, 0);
  const right = Math.min(x + width, frame.width);
  const bottom = Math.min(y + height, frame.height);
  // Nothing of it is in view — it was scrolled away, or it has no box at all.
  if (right < left || bottom < Math.max(y, 0)) return here(frame.width / 2, frame.height / 2);
  return here((left + right) / 2, bottom);
}
