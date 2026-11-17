import { describe, expect, it } from "vitest";
import { atEnd, back, BACK, below, DUR, follows, swift } from "./follow";

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
    // Including one whole pixel, which is the smallest move there is: the
    // browser will not sit half a pixel short of the end, it snaps back.
    expect(follows(true, at(1), at(0).scrollTop)).toBe(false);
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
    // "Near the bottom" is not the bottom. The first rule took hold at 79px;
    // this one took hold at 2px, which is still a place you can stop.
    for (const n of [1, 2, 3, 8, 20, 40, 79, 240]) expect(follows(false, at(n), at(n + 40).scrollTop)).toBe(false);
  });

  it("does not take hold a pixel short of it, however the stream grows", () => {
    /* The scenario a review reproduced against the first version of this:
       detach by 400px, scroll back down 399 of them, and the next thing the
       agent wrote took the viewport the remaining 501px. Nobody asked for
       that move, which is the whole complaint this change exists to answer,
       in miniature. */
    let following = follows(false, at(1), at(400).scrollTop);
    expect(following).toBe(false);
    // 500px arrives below. `scrollTop` has not moved, so the end is further
    // away than it was, and the rule is asked again on the next scroll.
    const grown = { scrollHeight: 5500, scrollTop: at(1).scrollTop, clientHeight: 600 };
    expect(below(grown)).toBe(501);
    following = follows(following, grown, grown.scrollTop);
    expect(following).toBe(false);
  });

  it("does not take hold two pixels short of it either", () => {
    const following = follows(false, at(2), at(400).scrollTop);
    expect(following).toBe(false);
    const grown = { scrollHeight: 5500, scrollTop: at(2).scrollTop, clientHeight: 600 };
    expect(follows(following, grown, grown.scrollTop)).toBe(false);
  });

  it("takes hold on any sub-pixel residual, because that is not a place to stop", () => {
    /* `scrollHeight` and `clientHeight` are rounded and `scrollTop` is not,
       so a genuine arrival is not guaranteed to read exactly 0 — measured at
       0.000 everywhere in Chrome, but this app ships in a webview nobody has
       measured. A fraction of a pixel is the end; a whole one is not. */
    for (const n of [0, 0.1, 0.25, 0.49]) expect(follows(false, at(n), at(40).scrollTop)).toBe(true);
    expect(atEnd(at(0.49))).toBe(true);
    expect(atEnd(at(1))).toBe(false);
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

describe("the pill", () => {
  it("is worth having only once getting back is real work", () => {
    expect(back(false, at(BACK + 1))).toBe(true);
    expect(back(false, at(BACK))).toBe(false);
    expect(back(false, at(40))).toBe(false);
  });

  it("is never drawn while following, however far up the content goes", () => {
    expect(back(true, at(4000))).toBe(false);
  });

  it("is nothing at all on a transcript shorter than its pane", () => {
    const short = { scrollHeight: 300, scrollTop: 0, clientHeight: 600 };
    expect(below(short)).toBe(0);
    expect(back(false, short)).toBe(false);
  });
});

describe("the travel", () => {
  it("starts where you are and ends at the end", () => {
    expect(swift(0)).toBe(0);
    expect(swift(1)).toBe(1);
    expect(swift(-1)).toBe(0);
    expect(swift(2)).toBe(1);
  });

  it("only ever goes forwards", () => {
    let last = -1;
    for (let p = 0; p <= 1.0001; p += 0.01) {
      const y = swift(p);
      expect(y).toBeGreaterThanOrEqual(last);
      last = y;
    }
  });

  it("covers most of the distance early, which is what `--ease-swift` is", () => {
    // Half the time, nearly all of the way: a long jump reads as "it moved, a
    // long way, down" and then settles.
    expect(swift(0.5)).toBeGreaterThan(0.8);
    expect(swift(0.25)).toBeGreaterThan(0.5);
  });

  it("is the window's own duration", () => {
    expect(DUR).toBe(140);
  });
});
