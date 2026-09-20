/**
 * The cases you cannot find by talking at the app.
 *
 * Every one of these is something a person does in the first minute — pausing,
 * fixing a word mid-sentence, dictating into the middle of a line — and none of
 * them is reproducible by hand twice in a row, because they depend on when a
 * delta happens to land.
 */
import { describe, expect, it } from "vitest";
import { close, open, reanchor, render, withDelta, withSegment } from "./splice";

const say = (text: string, caret = text.length) => open(text, caret);

describe("a delta revises rather than accumulates", () => {
  it("replaces the live segment every time", () => {
    let run = say("");
    run = withDelta(run, "write a test");
    run = withDelta(run, "write a test for");
    run = withDelta(run, "rewrite the test for the parser");
    expect(render(run)).toBe("rewrite the test for the parser");
  });

  it("keeps settled segments and revises only the last", () => {
    let run = withSegment(say(""), "Refactor the vault module.");
    run = withDelta(run, "The scope");
    run = withDelta(run, "The scope should be an enum");
    expect(render(run)).toBe("Refactor the vault module. The scope should be an enum");
  });
});

describe("spacing appears and disappears with the words", () => {
  it("separates dictation from text already typed", () => {
    expect(render(withDelta(say("Have a look at"), "the vault module"))).toBe("Have a look at the vault module");
  });

  it("does not double a space the typist already left", () => {
    expect(render(withDelta(say("Have a look at "), "the vault"))).toBe("Have a look at the vault");
  });

  it("holds both sides open when dictating into the middle", () => {
    const run = withDelta(open("Fix the bug.", 4), "in the parser");
    expect(render(run)).toBe("Fix in the parser the bug.");
  });

  it("leaves no spacing behind when every word is revised away", () => {
    const run = withDelta(withDelta(open("Fix the bug.", 4), "in the parser"), "");
    expect(render(run)).toBe("Fix the bug.");
  });
});

describe("typing while dictating", () => {
  it("follows an edit made to the left of the words", () => {
    const run = withDelta(say("Please "), "rewrite the parser");
    const moved = reanchor(run, "Could you please rewrite the parser");
    expect(moved).not.toBeNull();
    expect(moved!.before).toBe("Could you please ");
    expect(moved!.live).toBe("rewrite the parser");
    // And the next delta still lands in the right place.
    expect(render(withDelta(moved!, "rewrite the parser properly"))).toBe("Could you please rewrite the parser properly");
  });

  it("follows an edit made to the right of them", () => {
    const run = withDelta(open("Fix the bug.", 4), "in the parser");
    const moved = reanchor(run, "Fix in the parser the bug today.");
    expect(moved).not.toBeNull();
    expect(moved!.after).toBe("the bug today.");
    expect(render(withDelta(moved!, "in the lexer"))).toBe("Fix in the lexer the bug today.");
  });

  it("lets go when the edit lands in the dictated words", () => {
    const run = withDelta(say(""), "rewrite the parser");
    expect(reanchor(run, "rewrite the lexer")).toBeNull();
  });

  it("lets go when the words are deleted outright", () => {
    const run = withDelta(say("Please "), "rewrite the parser");
    expect(reanchor(run, "Please ")).toBeNull();
  });

  it("is unbothered by an event that changed nothing", () => {
    const run = withDelta(say("Please "), "rewrite the parser");
    expect(reanchor(run, render(run))).toEqual(run);
  });
});

describe("stopping", () => {
  it("settles the live segment and puts the caret after it", () => {
    const run = withDelta(withSegment(say(""), "One."), "Two");
    const { text, caret } = close(run);
    expect(text).toBe("One. Two");
    expect(caret).toBe(text.length);
  });

  it("puts the caret before the text it was dictated into, not at the end", () => {
    const run = withDelta(open("Fix the bug.", 4), "in the parser");
    const { text, caret } = close(run);
    expect(text).toBe("Fix in the parser the bug.");
    expect(text.slice(0, caret)).toBe("Fix in the parser");
  });

  it("gives back exactly what was there when nothing was said", () => {
    expect(close(say("Fix the bug.")).text).toBe("Fix the bug.");
  });
});
