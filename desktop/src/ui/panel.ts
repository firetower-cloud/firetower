/**
 * Whether the rail's panel is pinned open, per destination.
 *
 * A module rather than state in `Rail`, because two things set it and they are
 * not each other's children: the panel's own header has a close button, and
 * the title bar has the toggle that brings it back. Without the second one, a
 * collapsed panel could only be restored with ⌘\ — which is fine for somebody
 * who knows, and a dead end for everybody else.
 *
 * **Per destination, and it survives a reload.** The panel is collapsed when a
 * workspace opens, because the sheet there is a conversation and the width
 * belongs to it, and pinned everywhere else. A workspace gets its own key
 * rather than the Dashboard's: you are still in Dashboard when you are reading
 * one, but the answer to "how wide should this be" is not the same question.
 */
import { useEffect, useState } from "react";
import { destinationAt } from "~/ui/destinations";

const KEY = "firetower.panel";

/** Whose answer a path uses. */
export function panelKeyOf(path: string): string {
  if (path.startsWith("/sessions")) return "work";
  return destinationAt(path) ?? "home";
}

function read(): Record<string, boolean> {
  try {
    const held: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "{}");
    return held && typeof held === "object" ? (held as Record<string, boolean>) : {};
  } catch {
    /* a shape we no longer understand, or a private window */
    return {};
  }
}

let held = typeof window === "undefined" ? {} : read();
const watchers = new Set<() => void>();

export function panelPinned(at: string): boolean {
  return held[at] ?? at !== "work";
}

export function setPanelPinned(at: string, pinned: boolean) {
  held = { ...held, [at]: pinned };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(held));
  } catch {
    /* it applies now; it just does not survive a restart */
  }
  watchers.forEach((w) => w());
}

/** The answer for this path, and a way to change it. */
export function usePanel(path: string): [boolean, (pinned: boolean) => void] {
  const [, tick] = useState(0);
  useEffect(() => {
    const w = () => tick((n) => n + 1);
    watchers.add(w);
    return () => void watchers.delete(w);
  }, []);
  const at = panelKeyOf(path);
  return [panelPinned(at), (pinned: boolean) => setPanelPinned(at, pinned)];
}
