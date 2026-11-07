/**
 * Whether the rail's panel is pinned open.
 *
 * A module rather than state in `Rail`, because two things set it and they are
 * not each other's children: the panel's own header has a close button, and
 * the title bar has the toggle that brings it back. Without the second one, a
 * collapsed panel could only be restored with ⌘\ — which is fine for somebody
 * who knows, and a dead end for everybody else.
 *
 * **One answer, and it survives a reload.** It used to be one answer *per
 * destination*, which is why collapsing the panel did not stay collapsed:
 * clicking another destination icon read a different slot, and every slot
 * defaulted to open. From the outside that is the panel refusing to stay
 * shut — "if it's collapsed, it's collapsed", which is what was asked for and
 * what the drawing does with its single `S.panel`.
 *
 * The workspace keeps a separate answer, because the drawing keeps it too —
 * its sheet patches every workspace state to `panel:"collapsed"`. The sheet
 * there is a conversation and the width belongs to it, and you are still in
 * Dashboard while you read one, so "how wide should this be" is genuinely a
 * different question.
 *
 * Read at module load, before React renders, so a collapsed panel does not
 * flash open on launch and then shut — the same approach `main.tsx` takes for
 * the theme.
 */
import { useEffect, useState } from "react";

const KEY = "firetower.panel";

/** Whose answer a path uses. */
export function panelKeyOf(path: string): string {
  return path.startsWith("/sessions") ? "work" : "chrome";
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
