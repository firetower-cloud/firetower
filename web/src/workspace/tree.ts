"use client";

/**
 * Which directories of a session's tree are open.
 *
 * A module store rather than component state, for the same reason the panel is
 * one: the finder is mounted over the middle pane and the tree is in the rail,
 * and opening a result has to unfold the tree down to it. Threading a callback
 * between two components on opposite sides of the workbench would mean every
 * component in between carrying a prop it has no use for.
 *
 * Kept in the browser, per session. How somebody has unfolded a tree is not a
 * fact about the fleet, and it should still be unfolded that way after a
 * reload — walking back down four levels because a tab was refreshed is the
 * thing this whole rewrite exists to stop.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";

/** Expanded directory paths, by session. Relative to the workspace. */
type Trees = Record<string, string[]>;

const KEY = "firetower.tree";
const NONE: string[] = [];
const watching = new Set<() => void>();

// Compared by the raw string, so re-parsing does not look like a change to
// React and re-render every row on every tick.
let held: { raw: string | null; trees: Trees } = { raw: null, trees: {} };

function readAll(): Trees {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch {
    return held.trees;
  }
  if (held.raw === raw) return held.trees;

  let trees: Trees = {};
  try {
    if (raw) trees = JSON.parse(raw) as Trees;
  } catch {
    trees = {};
  }
  held = { raw, trees };
  return trees;
}

function write(trees: Trees) {
  const raw = JSON.stringify(trees);
  held = { raw, trees };
  try {
    window.localStorage.setItem(KEY, raw);
  } catch {
    // It still works for this visit, which is the part that matters.
  }
  for (const tell of watching) tell();
}

function listen(onChange: () => void) {
  watching.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    watching.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

/**
 * The row to bring into view.
 *
 * Not persisted and not a path on its own: the same file can be revealed twice
 * in a row — opened from the finder, scrolled away from, opened again — and a
 * bare path would look unchanged the second time. The count is what makes the
 * second reveal an event.
 */
let asked: { sessionId: string; path: string; count: number } | null = null;

export function useExpanded(sessionId: string): Set<string> {
  const paths = useSyncExternalStore(
    listen,
    () => readAll()[sessionId] ?? NONE,
    () => NONE,
  );
  return useMemo(() => new Set(paths), [paths]);
}

export function useTree(sessionId: string) {
  const expanded = useExpanded(sessionId);

  const toggle = useCallback(
    (path: string) => {
      const trees = readAll();
      const now = new Set(trees[sessionId] ?? NONE);
      if (now.has(path)) now.delete(path);
      else now.add(path);
      write({ ...trees, [sessionId]: [...now] });
    },
    [sessionId],
  );

  const collapseAll = useCallback(() => {
    const trees = readAll();
    write({ ...trees, [sessionId]: [] });
  }, [sessionId]);

  return { expanded, toggle, collapseAll };
}

/** The row the tree should scroll to, and a count that makes a repeat count. */
export function useRevealed(sessionId: string): string | null {
  const held = useSyncExternalStore(
    listen,
    () => asked,
    () => null,
  );
  return held && held.sessionId === sessionId ? `${held.path}#${held.count}` : null;
}

/**
 * Unfold the tree down to a file and ask for it to be scrolled to.
 *
 * Called from the finder, which is outside the rail and has no hook of its own
 * pointed at this session.
 */
export function reveal(sessionId: string, path: string) {
  const parts = path.split("/").slice(0, -1);
  const trees = readAll();
  const now = new Set(trees[sessionId] ?? NONE);

  let at = "";
  for (const part of parts) {
    at = at ? `${at}/${part}` : part;
    now.add(at);
  }

  asked = { sessionId, path, count: (asked?.count ?? 0) + 1 };
  write({ ...trees, [sessionId]: [...now] });
}
