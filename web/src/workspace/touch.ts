"use client";

/**
 * The half of "stop it zooming" that CSS cannot do.
 *
 * Three layers are needed and none of them is sufficient alone:
 *
 * 1. `maximumScale` / `userScalable` in the viewport export — honoured by
 *    Chrome and Firefox, and by Safari for everything except pinch.
 * 2. `touch-action: pan-x pan-y` on the workbench (`.no-zoom`) — refuses the
 *    pinch to the compositor, in every engine that reads it for zoom.
 * 3. This — Safari's own gesture recognisers, which are not touch events and
 *    which `touch-action` does not reach.
 *
 * Safari has ignored `user-scalable=no` for pinch since iOS 10, deliberately,
 * because taking zoom away from a web page takes away an accessibility
 * feature. That is a good rule and this is the case it is wrong about: the
 * workbench is a scrolling, dragging, tapping surface where a pinch is a
 * fumbled scroll, and the thing it was protecting — being able to make a diff
 * bigger — is a control on the diff instead.
 *
 * Which is why this is a hook mounted on one subtree rather than a listener
 * added once to the document. Tasks, Configuration, login and setup are
 * documents and keep pinch.
 *
 * `gesturestart` and friends are WebKit-only and are not in the DOM lib, so
 * they are subscribed by name. On every other browser nothing ever fires and
 * this costs three listeners that are never called.
 */

import { useEffect, type RefObject } from "react";

const GESTURES = ["gesturestart", "gesturechange", "gestureend"] as const;

export function useNoZoom(on: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = on.current;
    if (!el) return;

    // `preventDefault` on the start alone is enough in current Safari, but a
    // gesture that has already begun keeps sending changes — and a version
    // that starts one anyway would otherwise scale the page while the finger
    // moves and leave it there.
    const refuse = (e: Event) => e.preventDefault();

    // Not passive: the whole point is to cancel, and a passive listener may
    // not. Browsers default some of these to passive when the target is the
    // document, which is a second reason this is bound to an element.
    for (const kind of GESTURES) el.addEventListener(kind, refuse, { passive: false });
    return () => {
      for (const kind of GESTURES) el.removeEventListener(kind, refuse);
    };
  }, [on]);
}
