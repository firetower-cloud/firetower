"use client";

/**
 * How big the machine's own text is drawn, when somebody has said.
 *
 * This is what pinch-to-zoom was for. Taking zoom away from the workbench —
 * see `touch.ts` — is defensible only because the one screen where a pinch was
 * doing real work gets something better instead: a diff at 15px re-wraps to
 * the width it has, where a pinch at 1.4× makes a wide thing wider and pushes
 * the `+` and `−` off the left of the screen.
 *
 * Three sizes, not a slider. The question is "I can't read that" or "I want
 * more on screen", and neither of them is answered by a continuum.
 *
 * Kept in the browser, like the panel width and the tab layout: how big
 * somebody wants code is a fact about their eyes and their screen, not about
 * the fleet, and it should not follow them to a different machine.
 */

import { useCallback, useSyncExternalStore } from "react";

/** 13px is `--text-code`, so the default is exactly what the desk always had. */
export const CYCLE = [13, 15, 11] as const;

const KEY = "firetower.code-size";
const watching = new Set<() => void>();

let held: { raw: string | null; size: number } = { raw: null, size: CYCLE[0] };

function read(): number {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch {
    return CYCLE[0];
  }
  // Compared by the raw string, so re-parsing does not look like a change to
  // React and re-render every open diff on every tick.
  if (held.raw === raw) return held.size;

  const asked = Number(raw);
  // A size from an older build, or a hand-edited store, must not be able to
  // draw a patch at 400px or at nothing.
  const size = CYCLE.includes(asked as (typeof CYCLE)[number]) ? asked : CYCLE[0];
  held = { raw, size };
  return size;
}

function listen(onChange: () => void) {
  watching.add(onChange);
  // Another tab is another window on the same person. If they turned it up
  // there, it is turned up here.
  window.addEventListener("storage", onChange);
  return () => {
    watching.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function useCodeSize() {
  const size = useSyncExternalStore(
    listen,
    read,
    () => CYCLE[0],
  );

  const cycle = useCallback(() => {
    const now = read();
    const next = CYCLE[(CYCLE.indexOf(now as (typeof CYCLE)[number]) + 1) % CYCLE.length];
    try {
      window.localStorage.setItem(KEY, String(next));
    } catch {
      // It still works for this visit, which is the part that matters.
    }
    for (const tell of watching) tell();
  }, []);

  return { size, cycle };
}
