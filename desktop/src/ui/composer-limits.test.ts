import { describe, expect, it } from "vitest";
import { TAKES, roomFor } from "./Composer";

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
