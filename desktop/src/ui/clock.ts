/**
 * The passing of time, as something a component can re-render on.
 *
 * `elapsed(minutesSince(...))` is computed during render and depends on the
 * clock rather than on any prop, so a row that says `1m` goes on saying `1m`
 * until something unrelated happens to re-render it. In the rail that is
 * usually nothing at all: the list is fed by the event stream, so a workspace
 * nobody is touching produces no renders, and its age sits still for as long as
 * you watch it. Every screen here looked slightly dead for the same reason.
 *
 * One interval for the window, not one per row. A rail with a dozen rows wants
 * a dozen labels redrawn together, and each of them holding its own timer would
 * be a dozen wakeups a minute drifting out of step with each other.
 *
 * Counted, so it stops when the last subscriber goes. The fleet poll in
 * `fleet.ts` is a module-level interval that is never cleared, which is a thing
 * to do once and not twice.
 */
import { useEffect, useState } from "react";

/**
 * Half a minute, because the labels are whole minutes.
 *
 * `elapsed` rounds to `1m`, `2h`, `3d`, so a faster tick would redraw the same
 * string; this is the slowest interval at which a minute boundary is never
 * visibly late.
 */
const EVERY = 30_000;

const watchers = new Set<() => void>();
let ticking: ReturnType<typeof setInterval> | undefined;

function watch(w: () => void) {
  watchers.add(w);
  ticking ??= setInterval(() => watchers.forEach((it) => it()), EVERY);
  return () => {
    watchers.delete(w);
    if (watchers.size === 0 && ticking) {
      clearInterval(ticking);
      ticking = undefined;
    }
  };
}

/**
 * Re-render on the clock.
 *
 * Read for the effect rather than the value — the components using it call
 * `minutesSince` themselves, against a `Date.now()` this has just made stale.
 */
export function useNow(): number {
  const [now, set] = useState(() => Date.now());
  useEffect(() => watch(() => set(Date.now())), []);
  return now;
}
