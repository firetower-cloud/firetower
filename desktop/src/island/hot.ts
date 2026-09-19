/**
 * Hover, for a window the system will not talk to.
 *
 * The island never takes focus, and a webview in a window that is not key is
 * sent no mouse-moved events — so `:hover` inside it is dead until the window
 * has been clicked. That is why the pill opens from a shell-side poll of the
 * cursor rather than from the document. The rows inside it have the same
 * problem and had no such answer: the panel would open under the pointer and
 * then sit there inert, and the click it wanted was the click the hover was
 * supposed to save.
 *
 * The poll already knows where the cursor is. `elementFromPoint` is a
 * question for the document and not for AppKit, so it answers whatever is in
 * front, and what it finds is marked. Anything that wants to light up says so
 * by carrying `data-hot`, and styles the `true` exactly as it styles
 * `:hover` — both are left in place, because when the app is frontmost the
 * real one fires and there is no reason to have two mechanisms disagree.
 */

/** The nearest thing above the cursor that asked to be marked. */
const CANDIDATE = "[data-hot]";

let lit: Element | null = null;

/**
 * Mark whatever is under `at`, or nothing when the pointer is elsewhere.
 *
 * Attributes and not state: this runs on every tick of a 60ms poll, and a
 * re-render of the whole pill to move a background colour one row down is
 * both wasteful and a chance for the layout to shift under an animation that
 * is still running.
 */
export function warm(at: { x: number; y: number } | null): void {
  const found = at ? (document.elementFromPoint(at.x, at.y)?.closest(CANDIDATE) ?? null) : null;
  if (found === lit) return;
  lit?.setAttribute("data-hot", "false");
  found?.setAttribute("data-hot", "true");
  lit = found;
}
