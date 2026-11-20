/**
 * The right rail: how wide it is, and whether it docks at all.
 *
 * The window already has one of these — `Workbench` has opened a rail beside
 * the conversation since the redesign, and these are its numbers. They are
 * here rather than there so the second thing that opens one, the profile
 * drawer, is the *same* rail rather than a panel that happens to look like it.
 *
 * ## The bands, and what they are measured on
 *
 * **The pane, never the window.** A configuration pane sits inside the window
 * with the rail and the pane index beside it, so the window's width says
 * nothing about the room the pane has. On the desk at 1296 the pane is
 * 1296 − 62 rail − 252 index = **982**, which docks and leaves the screen 612.
 * The Duo's inner display is 669pt and lays out at **607** once the 62pt rail
 * is off: docking there would leave the screen 237, narrower than the drawer
 * itself, so it floats. That one number is why this is a function of the pane
 * and not of `window.innerWidth`.
 */

/** The rail can be dragged between these. `Workbench` opens at the default. */
export const RAIL_MIN = 288;
export const RAIL_DEFAULT = 368;

/**
 * What the grip between the pane and the rail costs the layout.
 *
 * **Two, from a four-pixel target.** `Workbench` does the same thing with a
 * negative margin: the strip somebody has to hit is wider than the gap it
 * takes, because a two-pixel drag target is a drag target nobody can find.
 * Two rather than three so the rail and its grip come to exactly **370** —
 * the drawer's measured width, which the prototype drew as 368 plus a border
 * and this spends as 368 plus a handle.
 */
export const GRIP = 2;

/** What the rail and its grip take out of the pane, together. */
export const railCost = (width: number) => width + GRIP;

/** At or above this pane width the rail sits beside the screen. */
export const DOCK_AT = 820;
/** Below this it takes the pane, because floating over 600 leaves nothing. */
export const FLOAT_AT = 600;

/**
 * What a rail does in a pane this wide.
 *
 * - `dock` — beside the screen, which keeps its scroll and its layout.
 * - `float` — over it, full height, dismissed by the ground behind it.
 * - `push` — the pane is the rail. Reached by dragging a desktop window
 *   narrow; nothing on a phone opens one of these.
 */
export type Band = "dock" | "float" | "push";

export function bandAt(pane: number): Band {
  if (pane >= DOCK_AT) return "dock";
  if (pane >= FLOAT_AT) return "float";
  return "push";
}

/**
 * How wide the rail may be, given the room around it.
 *
 * `Workbench` clamps at 60% of the window because the window is what its rail
 * sits in. In a pane the pane is, and the clamp has to be the same
 * proportion of the same thing the bands are measured on — otherwise a rail
 * refused the dock band could still be dragged over most of what is left.
 */
export function railWidth(held: number, room: number): number {
  return Math.round(Math.min(Math.max(room * 0.6, RAIL_MIN), Math.max(RAIL_MIN, held)));
}
