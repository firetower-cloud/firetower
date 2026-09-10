"use client";

/**
 * How much room there is, as two questions rather than one.
 *
 * The interface used to answer this with two Tailwind prefixes that happened
 * to be in the same files: the rail was `md:flex` and the panel was `xl:flex`,
 * and the band between them — 768 to 1279 — got the rail and no panel at all.
 * That band is most of the iPads there are. Every one except the 13" is under
 * 1280 in landscape, so an iPad Pro on a desk had no route to Files, Changes
 * or Ship, which is not a tablet edge case; it is the tablet.
 *
 * So the two questions are separated, and neither is "is this a phone":
 *
 * - **Is there room for a rail beside the work?** Needs 236px. Below `md` it
 *   becomes a drawer.
 * - **Is there room for a panel as well?** Needs another 320px. Below `xl`
 *   the three views it holds move into the pane, behind a switcher.
 *
 * The switcher is therefore not a mobile component. It is what Files, Changes
 * and Ship look like when they cannot be a side panel, which is true at 400px
 * and at 1200px alike — and one implementation serves both.
 *
 * ## Why these are hooks and not just classes
 *
 * Layout is CSS wherever it can be: `hidden md:flex` costs nothing, never
 * disagrees with itself, and is right before the first frame. These exist for
 * the cases that are not layout — a component tree that must not be mounted
 * twice because it owns state, and behaviour that differs, like whether Enter
 * sends a message.
 *
 * Prefer the class. Reach for these when rendering both would be wrong.
 */

import { useSyncExternalStore } from "react";

/** Tailwind's own `md`. Below it, the rail is a drawer. */
export const RAIL_AT = "(width >= 48rem)";

/** Tailwind's own `xl`. Below it, the panel's views move into the pane. */
export const PANEL_AT = "(width >= 80rem)";

/**
 * Subscribe once per query, not once per component.
 *
 * `useSyncExternalStore` calls `subscribe` with a fresh callback for every
 * component that uses it, and a `MediaQueryList` per component would mean a
 * listener per component. One list per query, with the watchers on it, is the
 * same shape the panel and the notes stores already use.
 */
const lists = new Map<string, MediaQueryList>();

function listFor(query: string): MediaQueryList | null {
  if (typeof window === "undefined") return null;
  let held = lists.get(query);
  if (!held) {
    held = window.matchMedia(query);
    lists.set(query, held);
  }
  return held;
}

function useMatches(query: string, whenUnknown: boolean): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = listFor(query);
      if (!list) return () => {};
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => listFor(query)?.matches ?? whenUnknown,
    // The static export is built with no window at all. Whatever is answered
    // here is what the shipped HTML is laid out for, and the first paint in a
    // browser corrects it — so the answer to give is the one that is least
    // wrong to look at for a frame, which is the desk.
    () => whenUnknown,
  );
}

/** Room for the rail beside the work. False on a phone. */
export function useHasRail(): boolean {
  return useMatches(RAIL_AT, true);
}

/** Room for the side panel as well. False on a phone and on most tablets. */
export function useHasPanel(): boolean {
  return useMatches(PANEL_AT, true);
}
