/**
 * The microphone, and what it becomes while it is listening.
 *
 * One control in two shapes. Idle it is the paperclip's sibling — same height,
 * same mute, same hover — because it is the same kind of thing: another way to
 * put something in the message. Listening it grows into a pill, and that is
 * the whole design argument: a 16px glyph cannot show a level, and a level is
 * the only thing that tells *hearing you* apart from *hung*. Without it the
 * honest question "is this working?" has no answer on screen, and the honest
 * answer is usually "yes, you are just not talking loudly enough".
 *
 * **No ember.** `STYLE.md` spends the only saturated colour on one thing — an
 * agent waiting on you — and a recording indicator is not that. Every red
 * record dot this went through was wrong for that reason. Bone and dim carry
 * it, and the motion does the rest.
 */
import { Loader2, Mic as MicGlyph, Square } from "lucide-react";
import { clock, type Voice } from "./state";

/** How many bars the level meter has. Odd, so it has a middle to peak from. */
const BARS = 7;

/**
 * The shape of the meter at a given loudness.
 *
 * Centre-weighted rather than a flat row: a bar chart of one number is seven
 * copies of that number, which reads as a progress bar and not as sound. The
 * curve makes the middle move most, the way every level meter anyone has seen
 * behaves.
 *
 * Exported for the demo page, which needs to draw a still frame of something
 * that is only ever seen moving.
 */
export function bars(level: number): number[] {
  return Array.from({ length: BARS }, (_, i) => {
    const from = Math.abs(i - (BARS - 1) / 2) / ((BARS - 1) / 2);
    const shape = 1 - from * 0.65;
    return Math.max(0.12, Math.min(1, level * shape));
  });
}

function Meter({ level, hearing }: { level: number; hearing: boolean }) {
  return (
    <span className="flex h-3.5 items-center gap-[2px]" aria-hidden>
      {bars(level).map((h, i) => (
        <span
          key={i}
          style={{ height: `${Math.round(h * 100)}%` }}
          /* The bars keep their width when they shrink, so silence is a row of
             dots rather than a gap — the meter stays the same size and the
             pill never reflows mid-sentence. */
          className={`w-[2px] rounded-full transition-[height,background-color] duration-100 ease-out ${
            hearing ? "bg-bone" : "bg-mute"
          }`}
        />
      ))}
    </span>
  );
}

export function Mic({
  state,
  onStart,
  onStop,
}: {
  state: Voice;
  onStart: () => void;
  onStop: () => void;
}) {
  if (state.at === "idle" || state.at === "asking") {
    return (
      <button
        onClick={() => onStart()}
        title="Dictate — speak and it writes"
        aria-label="Dictate"
        className="control text-mute hover:bg-raise hover:text-bone"
      >
        <MicGlyph className="h-4 w-4" strokeWidth={1.75} />
      </button>
    );
  }

  if (state.at === "connecting" || state.at === "settling") {
    /* Two different waits, one shape. Which one it is matters to nobody
       standing here: both mean "not yet, and not your turn to do anything",
       and the words underneath the composer say which. */
    return (
      <span
        className="control gap-2 border border-line bg-raise text-dim"
        title={state.at === "connecting" ? "Connecting" : "Finishing what you said"}
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2.5} />
        <span className="text-meta tabular-nums">{state.at === "connecting" ? "Connecting" : "Finishing"}</span>
      </span>
    );
  }

  return (
    <button
      /* Wrapped, not passed. `onStop` is `stop`, whose first argument is a
         callback handed the finished text — and `onClick={onStop}` would hand
         it a React synthetic event, which it would then try to call. */
      onClick={() => onStop()}
      title="Stop listening — the words stay in the message"
      aria-label="Stop listening"
      /* The whole pill is the stop target, not just the square. It is the only
         thing you want to press while it is open, and a 14px hit area for the
         one urgent control is the kind of detail that makes software feel
         cheap. */
      className="control gap-2 border border-line bg-raise text-bone transition-colors hover:bg-overlay"
    >
      <Square className="h-2.5 w-2.5 fill-current" strokeWidth={0} />
      <Meter level={state.level} hearing={state.hearing} />
      <span className="text-meta tabular-nums text-dim">{clock(state.seconds)}</span>
    </button>
  );
}
