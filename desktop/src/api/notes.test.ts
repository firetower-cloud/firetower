/**
 * What notes turn into when they are sent.
 *
 * The message is read by an agent, so the shape is load-bearing: a quote has
 * to be tellable from the remark about it, and a remark from the next quote.
 */
import { describe, expect, it } from "vitest";
import { asMessage, type Note } from "./notes";

const note = (quote: string, text: string): Note => ({
  id: Math.random().toString(36).slice(2),
  item: "i_1",
  quote,
  note: text,
});

describe("asMessage", () => {
  /**
   * Every caller used to sit behind a `notes.length > 0` render guard, so an
   * empty list was unreachable — until one of them became a button on a card
   * that is drawn whether or not anybody has written a note. A new agent was
   * then started with `0 notes on what you said:` and nothing under it as its
   * opening prompt.
   */
  it("is nothing at all when there are no notes", () => {
    expect(asMessage([])).toBe("");
  });

  it("says one in the singular", () => {
    const out = asMessage([note("the thing", "wrong")]);
    expect(out.startsWith("A note on what you said:")).toBe(true);
    expect(out).toContain("> the thing");
    expect(out).toContain("wrong");
  });

  it("numbers them, and puts each quote above its remark", () => {
    // Distinctive words: "no" would match inside "2 **no**tes" and the
    // ordering assertion would be about the header rather than the body.
    const out = asMessage([note("first", "remark-one"), note("second", "remark-two")]);
    expect(out.startsWith("2 notes on what you said:")).toBe(true);
    expect(out.indexOf("> first")).toBeLessThan(out.indexOf("remark-one"));
    expect(out.indexOf("remark-one")).toBeLessThan(out.indexOf("> second"));
    expect(out.indexOf("> second")).toBeLessThan(out.indexOf("remark-two"));
  });

  // A passage can contain its own blank lines and punctuation, so every line
  // of it carries the marker rather than only the first.
  it("marks every line of a quote", () => {
    expect(asMessage([note("one\ntwo", "x")])).toContain("> one\n> two");
  });
});
