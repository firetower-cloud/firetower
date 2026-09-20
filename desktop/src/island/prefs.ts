/**
 * The three things the island remembers.
 *
 * In `localStorage` rather than in a file the shell owns, for the same reason
 * the server registry is: the renderer is the only part that reads it, and a
 * preference that needs an IPC round trip to be known cannot be applied before
 * the first frame. Both windows share an origin, so the app can read this too.
 */
import type { Perch } from "./place";

export type Prefs = {
  /** Where it was left. Null until it has been dragged once. */
  perch: Perch | null;
  /** Out of the way until something actually needs you. */
  quiet: boolean;
  /** Kept out of screen recordings and shared screens. */
  unshared: boolean;
};

export const fresh: Prefs = { perch: null, quiet: false, unshared: false };

const KEY = "firetower.island";

export function read(): Prefs {
  try {
    const held = window.localStorage.getItem(KEY);
    if (!held) return fresh;
    const parsed = JSON.parse(held) as Partial<Prefs>;
    return {
      perch: parsed.perch ?? null,
      quiet: parsed.quiet === true,
      unshared: parsed.unshared === true,
    };
  } catch {
    // A corrupt entry is not a reason to have no island.
    return fresh;
  }
}

export function write(prefs: Prefs): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* the choice just does not survive a restart */
  }
}
