/**
 * Following the end of the transcript — and letting go of it.
 *
 * The rule this replaces decided by **proximity**: anywhere inside the bottom
 * 80px you were "following", whatever your hand had just done. And the thing
 * that acted on it ran every animation frame, so the band was 80px *between
 * two frames* rather than per gesture — one 40px wheel tick moved you 40px and
 * the frame 16ms later put you back, however long you kept swiping. Measured
 * against the real app: 2,100px of upward wheel input, 0px of movement, one
 * write per frame. A wheel escaped on a good notch and a trackpad never did,
 * which is why it was reported as "sometimes", and as a magnet.
 *
 * So following is **intent**, not distance. It is cleared by the gesture
 * itself — a wheel, a finger, a key — at any size, and taken up again only by
 * arriving at the true last line. There is no band left to outrun.
 *
 * Pure on purpose. All of it is a function of the three numbers any scroller
 * carries, so the contract is testable without a webview, and `Chat.tsx` holds
 * only the wiring.
 */

/** The three numbers this needs. Any `Element` is one of these. */
export type Edge = { scrollHeight: number; scrollTop: number; clientHeight: number };

/** How far the content runs on below the viewport. 0 is the last line. */
export const below = (e: Edge) => Math.max(0, e.scrollHeight - e.scrollTop - e.clientHeight);

/**
 * What counts as the end: two pixels, for sub-pixel layout and a fractional
 * zoom.
 *
 * Deliberately not a band anybody can sit inside. "Near the bottom" taking
 * hold again was the weaker version of the same complaint, and it is the
 * decision this whole change rests on.
 */
export const END = 2;

export const atEnd = (e: Edge) => below(e) <= END;

/**
 * The rule, for a scroll this app did not make itself.
 *
 * `from` is where the scroller was the last time anybody looked, so the sign
 * of the movement is what is read — not the distance from the bottom. Both
 * clauses are guarded by direction, and that is what separates a hand from the
 * two things that move a scroller without one:
 *
 * - **A hand that moved up and is now off the end lets go.** By any amount:
 *   one notch of a wheel, one frame of a trackpad.
 * - **Arriving at the end on the way down takes hold again.** Only there.
 * - **A clamp does neither.** Content collapsing under a reader who is already
 *   at the end moves `scrollTop` up with no hand involved, and leaves the
 *   distance to the bottom at zero — so it reads as neither a let-go nor an
 *   arrival, and somebody watching a stream keeps watching it.
 *
 * Whatever a gesture handler has already decided survives: the fall-through
 * returns what it was given, so a `wheel` that cleared following a moment
 * before this runs is not quietly undone by the pixel it moved.
 */
export function follows(following: boolean, e: Edge, from: number): boolean {
  const up = e.scrollTop < from - 0.5;
  if (up) return atEnd(e) ? following : false;
  return atEnd(e) ? true : following;
}
