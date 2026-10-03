"use client";

import { useCallback, useMemo, useState } from "react";

/**
 * What is ticked in a list, and the three questions every grouped action asks
 * of it: how many, is the header box on, and what happens when it is clicked.
 *
 * Holds ids rather than rows. A list that has just been refetched is new
 * objects for the same things, and a selection of objects would empty itself
 * every few seconds while somebody was deciding what to do with it.
 *
 * Ids that have gone are dropped when they are read rather than when they
 * vanish — no effect, nothing to keep in step, and the answer is right the
 * first time it is asked after a removal.
 */
export function useSelection(available: string[]) {
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());

  const here = useMemo(() => new Set(available), [available]);
  const picked = useMemo(
    () => available.filter((id) => ticked.has(id)),
    [available, ticked],
  );

  const toggle = useCallback((id: string, on: boolean) => {
    setTicked((was) => {
      const next = new Set(was);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const all = useCallback(
    (on: boolean) => setTicked(on ? new Set(here) : new Set()),
    [here],
  );

  const clear = useCallback(() => setTicked(new Set()), []);

  return {
    picked,
    /** Whether one row's box is ticked. */
    has: (id: string) => ticked.has(id),
    toggle,
    all,
    clear,
    count: picked.length,
    /** The header box: on when everything is, mixed when only some of it is. */
    every: picked.length > 0 && picked.length === available.length,
    some: picked.length > 0 && picked.length < available.length,
  };
}

/**
 * Run one action over everything ticked, and say what went wrong if anything
 * did.
 *
 * Sequential rather than `Promise.all`. These are writes against rules that
 * refer to each other — the last administrator, the last person who can
 * administer a directory — and firing them together means the server deciding
 * each one against a state that the others are in the middle of changing. In a
 * handful of rows the difference is imperceptible, and it is the difference
 * between "three of these were refused" and a race.
 */
export async function eachOf<T>(
  items: T[],
  act: (item: T) => Promise<unknown>,
): Promise<string | null> {
  let failed = 0;
  let first: string | null = null;

  for (const item of items) {
    try {
      await act(item);
    } catch (e) {
      failed += 1;
      first ??= e instanceof Error ? e.message : "That didn't work.";
    }
  }

  if (failed === 0) return null;
  // The sentence the server wrote, and how much of the rest happened — because
  // a grouped action that half worked is the case somebody has to be told
  // about plainly.
  return failed === items.length ? first : `${failed} of ${items.length} were refused. ${first}`;
}
