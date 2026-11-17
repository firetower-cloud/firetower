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
 * What counts as the end: **less than one pixel** from it.
 *
 * Deliberately not a band anybody can sit inside. "Near the bottom" taking
 * hold again was the weaker version of the original complaint, and it is the
 * decision this whole change rests on — so this started at two pixels and was
 * wrong at two pixels, because two pixels is a place you can stop: scroll up
 * 400, back down 399, and the next thing the agent wrote took the viewport
 * the remaining 501px without being asked.
 *
 * It is not zero either, and that is the other half of it. The arithmetic
 * above is two integers off the CSSOM and one double — `scrollHeight` and
 * `clientHeight` are rounded, `scrollTop` is not — so there is no guarantee
 * the three of them land on exactly 0 at a genuine arrival, and a rule that
 * demanded it could leave somebody unable to take hold again *at all*, which
 * is the same bug pointing the other way and a worse one for being silent.
 *
 * So it is measured rather than guessed. `scripts/at-the-end.mjs` drives the
 * real app and reads the distance at a real arrival: **0.000 in all 360
 * readings**, over three scenes, six device scales from 1 to 3, and ten
 * window heights, reached both by hand and by writing past the end. One pixel
 * short reads exactly 1.000, and *half* a pixel short is not a place the
 * scroller will sit — the browser quantises the offset and snaps it back to
 * the maximum. So every value in `(0, 1)` behaves identically here, and half
 * a pixel is the middle of that band: it cannot swallow a whole pixel, and it
 * absorbs any sub-pixel residual a layout or another webview produces. The
 * app has no page zoom — `bridge.zoom` is the window's, not the page's —
 * which is the condition that was measured; under CSS zoom the arithmetic
 * drifts past a pixel and no constant in this file would be right.
 */
export const END = 0.5;

export const atEnd = (e: Edge) => below(e) < END;

/**
 * How far up before the jump pill is worth having — about a third of the pane.
 *
 * Nearer than this the last line is still on screen and two flicks of the
 * wheel get you there, so a pill would be noise. Chosen against flicker rather
 * than measured.
 */
export const BACK = 240;

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
 *   at the end moves `scrollTop` up with no hand involved, and leaves them
 *   still at the end — so it reads as neither a let-go nor an arrival, and
 *   somebody watching a stream keeps watching it.
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

/**
 * Whether the pill is worth drawing: detached, and far enough up that getting
 * back by hand is real work.
 *
 * A transcript shorter than its pane has nothing below the fold, so this is
 * false there and nothing renders at all.
 */
export const back = (following: boolean, e: Edge) => !following && below(e) > BACK;

/**
 * `--dur-native`, which the pill's own travel is driven at.
 *
 * Here rather than read off the sheet because this module is a function of
 * numbers and nothing else; the token is the source and this is a copy of it,
 * in the one place that needs it as a number.
 */
export const DUR = 140;

/**
 * `--ease-swift` — `cubic-bezier(.16, 1, .3, 1)` — solved for y at x.
 *
 * The window owns its curve everywhere else, so the jump is driven by hand
 * rather than handed to `behavior: "smooth"`, whose duration belongs to the
 * browser and runs several hundred milliseconds on a transcript this long.
 * Bisection rather than Newton: 24 halvings land inside a ten-thousandth over
 * the whole domain, and it cannot diverge on a curve this steep at the end.
 */
export function swift(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const [x1, y1, x2, y2] = [0.16, 1, 0.3, 1];
  const on = (a: number, b: number, t: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  let lo = 0;
  let hi = 1;
  let t = x;
  for (let i = 0; i < 24; i++) {
    const at = on(x1, x2, t);
    if (Math.abs(at - x) < 1e-4) break;
    if (at < x) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }
  return on(y1, y2, t);
}
