import { describe, expect, it } from "vitest";
import { atEnd, below, follows } from "./follow";

/**
 * The contract the transcript's scroll was reported against: "it's like if
 * it's somehow magneted to the bottom".
 *
 * The bug was not the size of the band, it was the unit. `following` was set
 * from the distance to the bottom on every scroll event, and a per-frame pin
 * acted on it — so 80px was 80px *between two animation frames*, and a
 * trackpad delivering 40px in one of them never got away however long the
 * gesture ran. Widening the band would only have raised the speed you had to
 * beat, so what is asserted here is the *rule*: direction decides, and the
 * distance only ever says whether you have arrived.
 *
 * `at` is a scroller 5,000px long in a 600px pane — the shape the measurement
 * ran against — placed `n` pixels above its end.
 */
const at = (n: number) => ({ scrollHeight: 5000, scrollTop: 4400 - n, clientHeight: 600 });

/** One upward gesture of `px`, from `n` above the end, with nothing else. */
const wheeledUp = (n: number, px: number) => follows(false, at(n + px), at(n).scrollTop);

describe("letting go", () => {
  it("lets go on one notch, from the end, at any size at all", () => {
    for (const px of [1, 2, 3, 4, 10, 40, 100, 1200]) {
      // The gesture handler has already cleared it; the rule must not put it
      // back. 3px is the first size that is also off the end on its own.
      expect(wheeledUp(0, px)).toBe(false);
    }
  });

  it("lets go on a scroll with no gesture behind it — a scrollbar drag", () => {
    // Nothing cleared `following` first: the movement itself is the whole
    // signal, and 40px is the tick that moved 0px for five runs.
    expect(follows(true, at(40), at(0).scrollTop)).toBe(false);
    expect(follows(true, at(3), at(0).scrollTop)).toBe(false);
  });

  it("stays let go while the agent writes underneath", () => {
    // Content arriving below does not move `scrollTop`, so the only scroll
    // events are the reader's own. 200 of them, in both directions, never
    // reaching the end.
    let following = false;
    for (let n = 400; n > 10; n -= 2) following = follows(following, at(n), at(n + 2).scrollTop);
    expect(following).toBe(false);
  });

  it("does not let go because the content shrank under somebody watching", () => {
    // A disclosure collapsing at the end clamps `scrollTop` up with no hand
    // on anything — the one upward movement that is not a let-go. It leaves
    // the distance to the bottom at zero, which is how it is told apart.
    const shrunk = { scrollHeight: 4800, scrollTop: 4200, clientHeight: 600 };
    expect(follows(true, shrunk, 4400)).toBe(true);
  });
});

describe("taking hold again", () => {
  it("takes hold at the last line and nowhere short of it", () => {
    expect(follows(false, at(0), at(40).scrollTop)).toBe(true);
    expect(follows(false, at(2), at(40).scrollTop)).toBe(true);
    // "Near the bottom" is not the bottom. The old rule took hold at 79px.
    for (const n of [3, 8, 20, 40, 79, 240]) expect(follows(false, at(n), at(n + 40).scrollTop)).toBe(false);
  });

  it("holds what it was given when nothing has happened", () => {
    expect(follows(true, at(300), at(300).scrollTop)).toBe(true);
    expect(follows(false, at(300), at(300).scrollTop)).toBe(false);
  });

  it("is where the end is now, not where it was", () => {
    // The stream appended 400px while somebody sat at what used to be the
    // end. Still following, because the pin is what moves them.
    const grown = { scrollHeight: 5400, scrollTop: 4400, clientHeight: 600 };
    expect(atEnd(grown)).toBe(false);
    expect(below(grown)).toBe(400);
  });
});
