"use client";

/**
 * A layer that the system Back button closes.
 *
 * On a phone, anything drawn over the screen — a drawer, a sheet, a menu — is
 * expected to be dismissed by Back. Android has no other gesture for it, and
 * on iOS the edge-swipe means the same thing. Without this, opening the ship
 * sheet and pressing Back throws you out of the workspace with the sheet still
 * notionally open, which is the worst of both.
 *
 * The shape is the usual one: opening pushes an entry that goes nowhere — same
 * URL, a marker in `history.state` — so there is something for Back to pop.
 * Popping it calls `onClose`. Closing by any other route takes the entry back
 * out, so the layer does not leave a dead press behind it.
 *
 * ## What it does not do
 *
 * If the layer closes *because the app navigated* — `CloseWorkspace` sends you
 * to `/` when the workspace is gone, and tapping a workspace in the drawer
 * opens it — the entry is no longer the current one and cannot be popped
 * without undoing that navigation. It is left in place. The cost is one Back
 * press that appears to do nothing before the next one leaves, and the
 * alternative is racing the router for the history stack, which is how you
 * lose somebody's navigation rather than one press of a button.
 *
 * Not used above `md`. On a desk, Escape closes things and the browser's Back
 * belongs to the browser — a modal that eats a Back press there would be the
 * kind of cleverness that loses somebody the page they were reading.
 */

import { useEffect } from "react";
import { useHasRail } from "./layout";

/** Distinguishes nested layers, so a sheet over a drawer pops only itself. */
let count = 0;

export function useDismissible(open: boolean, onClose: () => void, kind: string) {
  const onDesk = useHasRail();

  useEffect(() => {
    if (!open || onDesk) return;

    const mark = `${kind}:${(count += 1)}`;
    const mine = () => (window.history.state as { ftLayer?: string } | null)?.ftLayer === mark;

    window.history.pushState({ ftLayer: mark }, "");

    const popped = () => onClose();
    window.addEventListener("popstate", popped);

    return () => {
      window.removeEventListener("popstate", popped);
      // Only if the entry is still ours. Closing *by* Back has already popped
      // it, and popping again would take the page somebody came from with it.
      if (mine()) window.history.back();
    };
  }, [open, onClose, onDesk, kind]);
}
