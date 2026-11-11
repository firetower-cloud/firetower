/**
 * The window's edges, where the window has no frame.
 *
 * `decorations: false` plus a title bar we draw ourselves means there is no
 * frame to grab. Eight transparent strips stand in for one, each calling
 * `startResizeDragging`, which is `gtk_window_begin_resize_drag` underneath:
 * the window manager takes the pointer and does the rest. Measured under Xvfb
 * and openbox, all eight drive a pixel-exact resize.
 *
 * **There is already a 5px border under this one, and it is not ours.**
 * tao 0.35.3 resizes an undecorated, resizable, unmaximised window from a
 * `scale_factor * 5`px border of its own, in GTK, below the DOM
 * (`platform_impl/linux/event_loop.rs`, `connect_button_press_event` →
 * `hit_test`) — and sets the resize cursor on motion while it is at it. So
 * these strips are not the difference between resizable and not. What they
 * add is the part that makes it usable: **16px bottom corners**, which are
 * the two people actually reach for and which tao gives 5px of; 6px rather
 * than 5 at the sides; and a top edge carved back to 4px so the *Close*
 * button keeps more of its corner. Both fire for a press within 5px of the
 * edge — one `begin_resize_drag` each, and no misbehaviour in any drag
 * measured.
 *
 * A consequence worth knowing: because tao's border is below the webview, a
 * modal scrim cannot cover it. With a dialog up these strips are unreachable
 * — `z-40` is under the `z-[60]` overlay — and the window still resizes from
 * its outer 5px, which also dismisses the dialog the way any press outside it
 * does.
 *
 * **Siblings of the title bar, not children of it.** `drag.ts` starts a *move*
 * from anything inside the bar that is not a control, and a strip nested in
 * there would start both at once — which is the bug that file's own comment
 * records. These are mounted beside it and nothing bubbles between them.
 *
 * The geometry is not arbitrary:
 *
 * - **6px** at the left, right and bottom; **4px** at the top, which is shared
 *   with the 40px title bar and the top of the three window buttons in it.
 * - **16px** corners, except the two at the top, which are the height of the
 *   top edge rather than square. A 16px square at the top right would take a
 *   bite out of *Close*, and a mis-grab there resizes a window instead of
 *   closing one. (tao's 5x5 at that corner is below us and stays whatever we
 *   draw, so the bite is 5px deep however careful this is.)
 * - **Nothing at all while maximised.** There is nothing to resize, and it
 *   gives the close button its corner back for the throw-to-the-corner
 *   gesture that only works when the window is maximised. tao's own border is
 *   off while maximised too, for the same reason, so the corner is genuinely
 *   the button's.
 *
 * The right-hand strip is the one real cost and it was chosen with open eyes:
 * the sheet is flush to that edge and its scroller is `.scroll-slim`, also
 * 6px, so dragging the thumb there becomes dragging the window. Leaving 2px of
 * thumb grabbable was judged worse than taking the whole thing honestly; the
 * answer if anybody reports it is a scrollbar gutter under
 * `[data-platform="linux"]`, not a thinner strip.
 *
 * `z-40` is above the chrome and the sheet and below a dialog, which is the
 * prototype's number: a strip above a modal's scrim would be a strip above
 * the one thing asking to be answered. What that costs is written above, and
 * it is small because tao's border is not ours to cover.
 */
import { useEffect, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { bridge } from "~/bridge";
import { isMac } from "~/platform";
import { tauriWindow } from "~/drag";

/** Tauri's own `ResizeDirection`, which is what `startResizeDragging` takes. */
type Direction = "North" | "South" | "East" | "West" | "NorthEast" | "NorthWest" | "SouthEast" | "SouthWest";

const EDGE = 6;
const TOP = 4;
const CORNER = 16;

/* Edges first, corners second, so the corners paint over the ends of the
   edges rather than under them — a corner that loses to an edge is a corner
   that resizes one axis, which is the hardest kind of wrong to notice.

   Exported for the test that holds these numbers: they are the whole of the
   design here, and the top corners being the height of the top edge is the
   one a well-meaning tidy-up would square off. */
export const STRIPS: { d: Direction; cursor: CSSProperties["cursor"]; box: CSSProperties }[] = [
  { d: "North", cursor: "ns-resize", box: { left: CORNER, right: CORNER, top: 0, height: TOP } },
  { d: "South", cursor: "ns-resize", box: { left: CORNER, right: CORNER, bottom: 0, height: EDGE } },
  { d: "West", cursor: "ew-resize", box: { top: TOP, bottom: CORNER, left: 0, width: EDGE } },
  { d: "East", cursor: "ew-resize", box: { top: TOP, bottom: CORNER, right: 0, width: EDGE } },
  { d: "NorthWest", cursor: "nwse-resize", box: { left: 0, top: 0, width: CORNER, height: TOP } },
  { d: "NorthEast", cursor: "nesw-resize", box: { right: 0, top: 0, width: CORNER, height: TOP } },
  { d: "SouthWest", cursor: "nesw-resize", box: { left: 0, bottom: 0, width: CORNER, height: CORNER } },
  { d: "SouthEast", cursor: "nwse-resize", box: { right: 0, bottom: 0, width: CORNER, height: CORNER } },
];

/**
 * Whether the window is maximised, now and whenever that changes.
 *
 * There is no maximise event to subscribe to, so this hangs off `onResized`,
 * which maximising and restoring both raise. `isMaximized` is a round trip to
 * the shell, and a resize *drag* raises one event per frame — so the ask is
 * held back until the window has been still for a moment. Without that, a
 * person dragging an edge pays for sixty of them a second to be told what they
 * already know.
 */
function useMaximized() {
  const [maxed, setMaxed] = useState(false);

  useEffect(() => {
    let gone = false;
    let drop: (() => void) | undefined;
    let settling: ReturnType<typeof setTimeout> | undefined;

    void (async () => {
      const w = await tauriWindow();
      if (!w || gone) return;
      const read = async () => {
        const now = await w.isMaximized().catch(() => false);
        if (!gone) setMaxed(now);
      };
      void read();
      drop = await w.onResized(() => {
        clearTimeout(settling);
        settling = setTimeout(() => void read(), 150);
      });
      // Unmounted while that was in flight: nothing will call the cleanup again.
      if (gone) drop();
    })();

    return () => {
      gone = true;
      clearTimeout(settling);
      drop?.();
    };
  }, []);

  return maxed;
}

export function Resize() {
  const maxed = useMaximized();

  /* macOS draws its own frame and has its own resize margin outside ours;
     two mechanisms at one edge is one too many. A browser tab has no window
     to resize — `?platform=linux` in a `tauri dev` build is how this is
     looked at from a Mac. */
  if (isMac || !bridge.native || maxed) return null;

  const grab = (d: Direction) => (e: ReactMouseEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    // Or the press selects text in whatever sits under the strip.
    e.preventDefault();
    void tauriWindow()
      .then((w) => w?.startResizeDragging(d))
      .catch(() => {
        /* The window manager refused, or there is none. Nothing to say. */
      });
  };

  return (
    <>
      {STRIPS.map(({ d, cursor, box }) => (
        <span
          key={d}
          aria-hidden
          data-resize={d}
          onMouseDown={grab(d)}
          className="fixed z-40"
          style={{ ...box, cursor }}
        />
      ))}
    </>
  );
}
