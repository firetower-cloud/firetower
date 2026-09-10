"use client";

/**
 * Whether the rail is showing, on a screen too narrow to keep it out.
 *
 * A module store rather than state in `Shell`, for one reason: the `☰` that
 * opens it is not always in `Shell`. Every document page gets the bar `Shell`
 * draws, but a workspace draws its own header — it has a `‹` and a `⋯` and a
 * status light to fit beside the same `☰` — and that header is three levels
 * down inside `children`. Lifting the state here is cheaper than threading a
 * callback through `Shell`, `Workspace`, and the header.
 *
 * Not persisted. Whether a drawer was open is not something to remember; it is
 * something somebody is doing right now, and a reload that came back with the
 * menu over the page would be the app second-guessing them.
 */

import { useCallback, useSyncExternalStore } from "react";

let open = false;
const watching = new Set<() => void>();

function set(next: boolean) {
  if (open === next) return;
  open = next;
  for (const tell of watching) tell();
}

function listen(onChange: () => void) {
  watching.add(onChange);
  return () => {
    watching.delete(onChange);
  };
}

export function useDrawer() {
  const showing = useSyncExternalStore(
    listen,
    () => open,
    () => false,
  );

  return {
    open: showing,
    show: useCallback(() => set(true), []),
    hide: useCallback(() => set(false), []),
  };
}
