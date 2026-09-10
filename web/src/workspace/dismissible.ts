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

import { useEffect, useRef } from "react";
import { useHasRail } from "./layout";

/** Distinguishes nested layers, so a sheet over a drawer pops only itself. */
let count = 0;

export function useDismissible(open: boolean, onClose: () => void, kind: string) {
  const onDesk = useHasRail();

  // Held in a ref rather than named as a dependency. Every caller passes an
  // inline arrow — `onClose={() => setReading(null)}` — so as a dependency it
  // was a new function on every render of the parent, and this effect tore
  // itself down and set itself up again each time. See below for why that was
  // fatal rather than merely wasteful.
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open || onDesk) return;

    const mark = `${kind}:${(count += 1)}`;
    const mine = () => (window.history.state as { ftLayer?: string } | null)?.ftLayer === mark;

    // Pushed a tick late, and cancelled if this effect is torn down before the
    // tick arrives.
    //
    // `history.back()` in the cleanup is asynchronous: it queues a `popstate`
    // rather than raising one. A set-up, tear-down, set-up in the same tick —
    // which is exactly what React does in development, and what a re-render
    // used to do — therefore pushed, called back, and pushed again, and the
    // pop from that `back` landed a few milliseconds later on the listener the
    // *second* set-up had just registered. It read as somebody pressing Back,
    // so every sheet and every modal closed itself before it was ever painted.
    //
    // Deferring means a set-up that does not survive the tick never touches
    // history at all, so there is no pop to misread.
    let live = true;
    let pushed = false;
    const push = window.setTimeout(() => {
      if (!live) return;
      window.history.pushState({ ftLayer: mark }, "");
      pushed = true;
    }, 0);

    const popped = () => close.current();
    window.addEventListener("popstate", popped);

    return () => {
      live = false;
      window.clearTimeout(push);
      window.removeEventListener("popstate", popped);
      // Only if we got as far as pushing, and only if the entry is still ours.
      // Closing *by* Back has already popped it, and popping again would take
      // the page somebody came from with it.
      if (pushed && mine()) window.history.back();
    };
  }, [open, onDesk, kind]);
}
