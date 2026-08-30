"use client";

/**
 * The right panel: which view, how wide, and whether it is there at all.
 *
 * A module store rather than a context, for the same reason the notes are one:
 * two components far apart need to agree — the panel draws itself, and the Ship
 * button in a session header two levels away has to be able to bring the Ship
 * view forward. Threading a callback between them would mean every component in
 * between carrying a prop it has no use for.
 *
 * Kept in the browser, like the tab layout. How somebody has arranged their
 * window is not a fact about the fleet.
 */

import { useCallback, useSyncExternalStore } from "react";

export type View = "files" | "changes" | "ship";

export const VIEWS: { id: View; label: string; key: string }[] = [
  { id: "files", label: "Files", key: "1" },
  { id: "changes", label: "Changes", key: "2" },
  { id: "ship", label: "Ship", key: "3" },
];

export type Panel = {
  view: View;
  /** Collapsed to the strip. The strip stays, so there is a way back. */
  open: boolean;
  width: number;
};

/** 320 is tight for a commit message and generous for a file tree. */
export const NARROWEST = 280;
export const WIDEST = 560;
const START: Panel = { view: "files", open: true, width: 320 };

const KEY = "firetower.panel";
const watching = new Set<() => void>();

let held: { raw: string | null; panel: Panel } = { raw: null, panel: START };

function read(): Panel {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch {
    return START;
  }
  // Compared by the raw string, so re-parsing does not look like a change to
  // React and re-render everything watching on every tick.
  if (held.raw === raw) return held.panel;

  let panel = START;
  try {
    if (raw) panel = { ...START, ...(JSON.parse(raw) as Partial<Panel>) };
  } catch {
    panel = START;
  }
  // A width from an older build, or a hand-edited store, must not be able to
  // push the panel off the screen.
  panel.width = Math.min(WIDEST, Math.max(NARROWEST, panel.width));
  held = { raw, panel };
  return panel;
}

function write(next: Panel) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
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

export function usePanel() {
  const panel = useSyncExternalStore(listen, read, () => START);

  const show = useCallback((view: View) => {
    const now = read();
    // Pressing the view you are already on closes the panel, which is what
    // every activity bar does and what somebody reaching for more width will
    // try. Coming from a *different* view always opens rather than toggling —
    // the Ship button asking for Ship must never close the panel.
    write(
      now.view === view && now.open
        ? { ...now, open: false }
        : { ...now, view, open: true },
    );
  }, []);

  /** Bring a view forward, never closing. For callers outside the strip. */
  const reveal = useCallback((view: View) => {
    write({ ...read(), view, open: true });
  }, []);

  const setWidth = useCallback((width: number) => {
    write({ ...read(), width: Math.min(WIDEST, Math.max(NARROWEST, width)) });
  }, []);

  const toggle = useCallback(() => {
    const now = read();
    write({ ...now, open: !now.open });
  }, []);

  return { ...panel, show, reveal, setWidth, toggle };
}

/**
 * Bring a view forward from outside React.
 *
 * The session header's Ship button is inside React and uses `reveal`, but this
 * exists for the keyboard handler, which is a plain listener and has no hook to
 * call.
 */
export function revealPanel(view: View) {
  write({ ...read(), view, open: true });
}
