"use client";

/**
 * A document pushed over a workspace, on a screen with one column.
 *
 * A desk opens a file, a diff or a preview as a **tab**, beside the
 * conversation that produced it — which is the whole reason the review panel
 * stopped being a modal. None of that survives a single column: there is no
 * beside, a tab strip of six things is unreadable at 375px, and closing a tab
 * leaves you on whichever neighbour `without()` picks rather than on the list
 * you opened it from.
 *
 * So below `xl` the same three things are one screen pushed on top, with a `‹`
 * that returns to exactly where it came from. It is a stack one deep, because
 * nothing here opens anything else.
 *
 * ## Why this hangs off `useOpen`
 *
 * Every caller — the tree, the changes list, the ship panel — says
 * `open.diff(path)` and should not have to care which of the two it gets.
 * `useOpen` is the one place that already exists to answer "open this thing",
 * so it is where the fork belongs. Nothing else changes.
 *
 * Not persisted, and cleared when the workspace changes: a pushed document is
 * where somebody is right now, not where they live.
 */

import { useCallback, useSyncExternalStore } from "react";

export type Overlay =
  | { kind: "file"; path: string }
  | { kind: "diff"; path: string }
  | { kind: "preview"; port: number };

let held: Overlay | null = null;
const watching = new Set<() => void>();

function tell() {
  for (const watcher of watching) watcher();
}

function listen(onChange: () => void) {
  watching.add(onChange);
  return () => {
    watching.delete(onChange);
  };
}

export function showOverlay(next: Overlay) {
  held = next;
  tell();
}

export function closeOverlay() {
  if (!held) return;
  held = null;
  tell();
}

export function useOverlay() {
  const now = useSyncExternalStore(
    listen,
    () => held,
    () => null,
  );
  return {
    overlay: now,
    // Wrapped rather than passed through: these read the module and close over
    // nothing, so the identity is stable either way — and the lint rule that
    // insists on an inline function is right that a bare reference here is
    // impossible to check.
    show: useCallback((next: Overlay) => showOverlay(next), []),
    close: useCallback(() => closeOverlay(), []),
  };
}
