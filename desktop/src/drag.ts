/**
 * Which parts of the page are the window.
 *
 * Four attempts. The first three all look correct and none of them work, so
 * they are worth recording:
 *
 * 1. `-webkit-app-region: drag` is a Chromium feature. WKWebView does not
 *    implement it, so under Tauri it silently does nothing.
 * 2. `data-tauri-drag-region` alone. Tauri's injected script watches for it and
 *    calls `start_dragging` — but on a window with an overlay title bar AppKit
 *    is already dragging from its own strip at the top, and the two disagree
 *    about where the region ends.
 * 3. **Both at once**, which is worse than either: React's handler runs while
 *    the event bubbles through its root, Tauri's runs when the same event
 *    reaches `document`, and one mousedown therefore starts two drags. The
 *    second arrives while the first is in flight and the window stops moving —
 *    so it drags once, then refuses, then drags once again. That is the bug
 *    this file existed in for one commit.
 *
 * 4. What is here: **one mechanism**, ours, guarded against re-entry. The
 *    attribute is deliberately *not* emitted, or Tauri's script would be the
 *    second one again.
 *
 * Interactive children opt out by being interactive: the check walks up from
 * the event target and refuses if it finds a control.
 */
import type { MouseEvent as ReactMouseEvent } from "react";

const CONTROLS =
  "button, a, input, select, textarea, label, [role='button'], [contenteditable='true']";

/**
 * A drag already in flight.
 *
 * The webview usually does not see the `mouseup` that ends a native drag — the
 * window server has the mouse by then — so this is cleared on anything that
 * means the drag is over, plus a fallback timer. Without it a fast second
 * mousedown can still double up.
 */
let dragging = false;

function release() {
  dragging = false;
}

if (typeof window !== "undefined") {
  window.addEventListener("mouseup", release);
  window.addEventListener("blur", release);
  window.addEventListener("focus", release);
}

async function tauriWindow() {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (!w.__TAURI_INTERNALS__) return null;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

/** Spread onto any surface that should move the window. */
export const drag = {
  /** Kept for an Electron shell, where this is the whole mechanism. Inert here. */
  className: "drag",

  onMouseDown: (e: ReactMouseEvent<HTMLElement>) => {
    if (e.button !== 0 || dragging) return;
    if ((e.target as HTMLElement).closest(CONTROLS)) return;

    dragging = true;
    // Stops the text cursor appearing mid-drag.
    e.preventDefault();

    void tauriWindow()
      .then((w) => w?.startDragging())
      .catch(release);

    // The drag can end without this window hearing about it.
    window.setTimeout(release, 1000);
  },

  onDoubleClick: (e: ReactMouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest(CONTROLS)) return;
    void tauriWindow().then((w) => w?.toggleMaximize());
  },
} as const;
