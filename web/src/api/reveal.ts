/**
 * Letting text arrive at a readable pace.
 *
 * The agent does not stream smoothly. Measured against `claude -p` directly,
 * with Firetower entirely out of the path, text arrives in bursts of roughly a
 * hundred and fifty characters every half second — that is the CLI's own flush
 * interval and there is nothing on our side of it to change.
 *
 * So this is cosmetic, and says so. It hands out what has already arrived at a
 * steady rate, which turns five jumps into something that reads as writing. It
 * never shows a character that has not arrived, and it never falls behind: if
 * it is a long way back — a reconnect replaying a whole session, a big paste —
 * it catches up rather than politely typing out four hundred lines at somebody
 * who just refreshed.
 */

import { useEffect, useState } from "react";

/** Characters per second. Faster than reading speed, slower than a burst. */
const PACE = 420;

/** Past this far behind, stop pacing and catch up. */
const TOO_FAR = 400;

/**
 * Reveal `text` gradually while it is still growing.
 *
 * Pass `settled` once nothing more is coming — a finished item shows in full at
 * once, because there is nobody left to keep company.
 */
export function useReveal(text: string, settled: boolean): string {
  const [shown, setShown] = useState(0);

  // Derived rather than stored. The cases that should skip the animation —
  // finished, far behind, or text that shrank because an optimistic message was
  // replaced by the real one — are answered here, during render, instead of by
  // setting state inside an effect and rendering twice for each one.
  const target = text.length;
  const skip = settled || shown > target || target - shown > TOO_FAR;
  const at = skip ? target : shown;

  useEffect(() => {
    if (at >= target) return;

    let frame = 0;
    let last: number | undefined;

    const step = (now: number) => {
      const since = last === undefined ? 16 : now - last;
      last = now;
      const by = Math.max(1, Math.round((PACE * since) / 1000));
      // `at` rather than the previous value: a render may have skipped ahead
      // while a frame was in flight, and going backwards would rewrite text
      // somebody is already reading.
      setShown((seen) => Math.min(target, Math.max(seen, at) + by));
      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [at, target]);

  return text.slice(0, at);
}
