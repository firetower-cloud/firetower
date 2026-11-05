import { describe, expect, it } from "vitest";
import { roomFor, sift, TAKES } from "./attach";

/**
 * The cap on a batch, and what it says about the part it would not take.
 *
 * The interesting case is never all-or-nothing. It is seven already attached
 * and six more dropped, where the honest answer is "three of these, and here
 * is what happened to the rest" — and where an off-by-one means either an
 * eleventh file or a refusal for a file that would have fit.
 */
describe("how many more files a message will take", () => {
  it("takes a batch that fits, with nothing to say", () => {
    expect(roomFor(0, ["a.png", "b.png"])).toEqual({ fit: 2, refusals: [] });
  });

  it("takes exactly the last free slot without complaining", () => {
    const names = Array.from({ length: 10 }, (_, i) => `${i}.png`);
    expect(roomFor(0, names)).toEqual({ fit: 10, refusals: [] });
    expect(roomFor(9, ["one-more.png"])).toEqual({ fit: 1, refusals: [] });
  });

  it("fills what is left and names the overflow", () => {
    const { fit, refusals } = roomFor(7, ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt", "f.txt"]);
    expect(fit).toBe(3);
    expect(refusals).toEqual(["10 files at a time — d.txt and 2 others were not taken."]);
  });

  it("names a single leftover in the singular", () => {
    expect(roomFor(9, ["a.txt", "b.txt"]).refusals).toEqual([
      "10 files at a time — b.txt was not taken.",
    ]);
  });

  it("counts one other as an other, not as others", () => {
    // Two over the line reads "x and 1 other were". That is the case an
    // `n - 1` plural gets wrong, and it is what a twelve-file drop produces.
    const names = [...Array.from({ length: 10 }, (_, i) => `${i}.txt`), "k.txt", "l.txt"];
    expect(roomFor(0, names).refusals).toEqual([
      "10 files at a time — k.txt and 1 other were not taken.",
    ]);
  });

  it("takes none once the message is full, and still says why", () => {
    const { fit, refusals } = roomFor(10, ["late.txt"]);
    expect(fit).toBe(0);
    expect(refusals).toEqual(["10 files at a time — late.txt was not taken."]);
  });

  it("cannot be walked around by a message that is somehow over the cap", () => {
    // Not reachable today, but `fit` must never come back negative: it is used
    // as a slice length, and a negative one silently drops from the end.
    expect(roomFor(12, ["a.txt"]).fit).toBe(0);
  });
});

describe("what the drop overlay promises", () => {
  it("states the count and both size caps, from the constants that enforce them", () => {
    // Pinned so the caption cannot quietly disagree with `take`. The file
    // figure must also match `attachments::BIGGEST` on the worker.
    expect(TAKES).toBe("Up to 10 files — images to 5 MB, everything else to 25 MB");
  });
});

/** A file of a given size, which is all `sift` reads besides the type. */
const file = (name: string, bytes: number, type = "") =>
  ({ name, size: bytes, type }) as unknown as File;
const MB = 1024 * 1024;

/**
 * Both caps at once — which is the only way either of them is ever met.
 *
 * Two screens now decide what to accept: the conversation's composer, which
 * uploads straight away, and the New page, which holds the file until there is
 * a workspace to put it in. They must agree, and they agree by both calling
 * this.
 */
describe("which of a batch is taken", () => {
  it("takes what fits and says nothing", () => {
    const { taken, refusals } = sift(0, [file("a.png", 1 * MB, "image/png"), file("b.zip", 9 * MB)]);
    expect(taken.map((f) => f.name)).toEqual(["a.png", "b.zip"]);
    expect(refusals).toEqual([]);
  });

  it("holds an image to 5 MB and everything else to 25", () => {
    // 10 MB is over for a picture and well under for anything else, which is
    // the case that proves the cap is chosen per file rather than per batch.
    const { taken, refusals } = sift(0, [file("big.png", 10 * MB, "image/png"), file("big.zip", 10 * MB)]);
    expect(taken.map((f) => f.name)).toEqual(["big.zip"]);
    expect(refusals).toEqual(["big.png is over 5 MB."]);
  });

  it("refuses an oversize file before counting slots, so the size is what it says", () => {
    const { taken, refusals } = sift(9, [file("huge.zip", 30 * MB), file("fits.txt", 1)]);
    expect(taken.map((f) => f.name)).toEqual(["fits.txt"]);
    expect(refusals).toEqual(["huge.zip is over 25 MB."]);
  });

  it("counts only the files that passed the size check against the cap", () => {
    // Nine held, one slot: an oversize file must not eat it and leave the one
    // that would have fitted refused for being the eleventh.
    const { taken } = sift(9, [file("huge.png", 9 * MB, "image/png"), file("small.png", 1, "image/png")]);
    expect(taken.map((f) => f.name)).toEqual(["small.png"]);
  });

  it("carries a refusal the caller already knew about, first", () => {
    const { refusals } = sift(0, [file("big.png", 10 * MB, "image/png")], ["src is a folder."]);
    expect(refusals).toEqual(["src is a folder.", "big.png is over 5 MB."]);
  });
});
