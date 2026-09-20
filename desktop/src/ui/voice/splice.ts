/**
 * Putting speech into a box somebody is still typing in.
 *
 * The naive version appends deltas and is wrong twice over.
 *
 * **A delta is a revision, not an addition.** `gpt-4o-transcribe` re-reads its
 * own segment as it hears more of it: "write a test for" becomes "write a test
 * for the parser" becomes "rewrite the test for the parser". Appending those
 * three gives you all three, run together. So a delta *replaces* the live
 * segment; only a completed segment is ever added to.
 *
 * **The textarea stays editable.** Dictation does not lock the box — you will
 * want to fix a word while still talking, and software that forbids it is
 * software people stop using. So the caret is not an anchor that can be
 * trusted: by the time the next delta lands, the text around it may have
 * moved. What is tracked instead is the text either side of the dictated run,
 * and every incoming edit is diffed against what we last wrote to work out
 * which side it landed on.
 *
 * The rule when an edit lands *inside* the dictated run: the human wins,
 * always, and dictation lets go of that text. Anything else means watching the
 * model overwrite the word you just corrected, which is the single most
 * enraging thing a dictation box can do.
 *
 * Everything here is a pure function of a `Run`, so the awkward cases are
 * tests rather than something to discover by talking at the app.
 */

/** A dictation in progress, as four pieces of the box's contents. */
export type Run = {
  /** Everything left of where dictation started. */
  before: string;
  /** Everything right of it. */
  after: string;
  /** Segments the model has finished with. Never revised again. */
  settled: string;
  /** The segment still being revised. Replaced wholesale by every delta. */
  live: string;
};

/** Start one at the caret. */
export function open(text: string, caret: number): Run {
  const at = Math.max(0, Math.min(caret, text.length));
  return { before: text.slice(0, at), after: text.slice(at), settled: "", live: "" };
}

/** The dictated words, settled and live, as one string. */
export function spoken(run: Run): string {
  return [run.settled, run.live].filter(Boolean).join(" ");
}

/**
 * What the box should say.
 *
 * The spacing is here rather than baked into the pieces so that it disappears
 * on its own when the words do — dictating into the middle of a sentence and
 * then deleting every word must not leave two spaces behind.
 */
export function render(run: Run): string {
  const words = spoken(run);
  if (!words) return run.before + run.after;
  const lead = run.before && !/\s$/.test(run.before) ? " " : "";
  const tail = run.after && !/^\s/.test(run.after) ? " " : "";
  return run.before + lead + words + tail + run.after;
}

/**
 * Where the dictated run sits inside `render(run)`, spacing included.
 *
 * The lead and tail spaces are part of the run, not part of what was typed
 * either side — dictation invented them and dictation takes them away again.
 */
function region(run: Run): { start: number; end: number } {
  return { start: run.before.length, end: render(run).length - run.after.length };
}

/**
 * Where the last dictated word ends.
 *
 * Inside `region`, and not the same as its end: that includes the space held
 * open in front of whatever was already there. The caret belongs against the
 * word, so that carrying on typing continues the sentence rather than starting
 * the next one a space early.
 */
function tip(run: Run): number {
  const lead = run.before && !/\s$/.test(run.before) ? 1 : 0;
  return run.before.length + lead + spoken(run).length;
}

/** A delta: the live segment, revised. */
export const withDelta = (run: Run, text: string): Run => ({ ...run, live: text });

/** A segment the model has finished. It joins `settled` and stops moving. */
export const withSegment = (run: Run, text: string): Run => ({
  ...run,
  settled: [run.settled, text.trim()].filter(Boolean).join(" "),
  live: "",
});

/** Stop. The live segment settles, and the caret lands after the last word. */
export function close(run: Run): { text: string; caret: number } {
  const done = withSegment(run, run.live);
  return { text: render(done), caret: tip(done) };
}

/**
 * Somebody typed. Work out where, and either follow it or let go.
 *
 * Returns the run with its edges moved, or `null` when the edit landed in the
 * dictated words themselves — which ends dictation with what they typed.
 *
 * The diff is a common prefix and a common suffix, which is all a textarea can
 * produce in one event: a keystroke, a paste, a selection replaced, a delete.
 * It cannot tell a deletion at the end of `before` from one at the start of
 * the dictated run, and it does not have to — both are edits a person made
 * next to their own words, and both resolve the same way.
 */
export function reanchor(run: Run, typed: string): Run | null {
  const was = render(run);
  if (typed === was) return run;

  let head = 0;
  while (head < was.length && head < typed.length && was[head] === typed[head]) head++;
  let tail = 0;
  while (
    tail < was.length - head &&
    tail < typed.length - head &&
    was[was.length - 1 - tail] === typed[typed.length - 1 - tail]
  )
    tail++;

  const { start, end } = region(run);
  const touched = { from: head, to: was.length - tail };

  // Entirely left of the words: `before` absorbs it, everything else holds.
  if (touched.to <= start) {
    const held = was.length - run.before.length;
    return { ...run, before: typed.slice(0, typed.length - held) };
  }
  // Entirely right of them: `after` absorbs it.
  if (touched.from >= end) return { ...run, after: typed.slice(end) };

  // In the words. Theirs now.
  return null;
}
