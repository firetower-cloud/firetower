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

describe("deltas are fragments that join up", () => {
  /* Captured from the API, not invented: this is exactly what four seconds of
     speech produced, leading spaces and split word included. The bug this
     guards against rendered the whole sentence as "." — every fragment
     overwriting the last — and it read as the microphone not working. */
  const REAL = [" Ref", "actor", " the", " vault", " module", " so", " the", " scope",
    " is", " a", " typed", " enum", " rather", " than", " a", " free", " string", "."];

  it("joins a real delta stream back into the sentence", () => {
    const run = REAL.reduce(withDelta, say(""));
    expect(render(run)).toBe("Refactor the vault module so the scope is a typed enum rather than a free string.");
  });

  it("reads correctly at every point along the way, not just at the end", () => {
    let run = say("");
    const seen: string[] = [];
    for (const fragment of REAL) {
      run = withDelta(run, fragment);
      seen.push(render(run));
    }
    // Each rendering extends the one before it; nothing ever shrinks.
    for (let i = 1; i < seen.length; i++) expect(seen[i].startsWith(seen[i - 1])).toBe(true);
    expect(seen[3]).toBe("Refactor the vault");
  });

  it("does not leak the leading space a fragment arrives with", () => {
    expect(render(withDelta(say(""), " Refactor"))).toBe("Refactor");
  });

  it("keeps settled transcripts and goes on joining after them", () => {
    let run = withSegment(say(""), "Refactor the vault module.");
    run = withDelta(run, " The scope");
    run = withDelta(run, " should be an enum");
    expect(render(run)).toBe("Refactor the vault module. The scope should be an enum");
  });
});

describe("a completed transcript replaces the fragments it is made of", () => {
  it("does not say the sentence twice", () => {
    let run = say("");
    run = withDelta(run, " refactor the vault");
    // The model's own tidied version of exactly those words.
    run = withSegment(run, "Refactor the vault.");
    expect(render(run)).toBe("Refactor the vault.");
  });
});

describe("spacing appears and disappears with the words", () => {
  it("separates dictation from text already typed", () => {
    expect(render(withDelta(say("Have a look at"), " the vault module"))).toBe("Have a look at the vault module");
  });

  it("does not double a space the typist already left", () => {
    expect(render(withDelta(say("Have a look at "), " the vault"))).toBe("Have a look at the vault");
  });

  it("holds both sides open when dictating into the middle", () => {
    const run = withDelta(open("Fix the bug.", 4), "in the parser");
    expect(render(run)).toBe("Fix in the parser the bug.");
  });

  it("leaves no spacing behind when the model heard nothing", () => {
    // A commit that transcribes to nothing — a cough, a knocked microphone.
    const run = withSegment(withDelta(open("Fix the bug.", 4), " in the parser"), "");
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
    // And the next fragment still lands in the right place.
    expect(render(withDelta(moved!, " properly"))).toBe("Could you please rewrite the parser properly");
  });

  it("follows an edit made to the right of them", () => {
    const run = withDelta(open("Fix the bug.", 4), "in the parser");
    const moved = reanchor(run, "Fix in the parser the bug today.");
    expect(moved).not.toBeNull();
    expect(moved!.after).toBe("the bug today.");
    expect(render(withDelta(moved!, " quickly"))).toBe("Fix in the parser quickly the bug today.");
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
