/**
 * The window's edges, where the window has no frame.
 *
 * `decorations: false` plus a title bar we draw ourselves means there is no
 * frame to grab. Five transparent strips stand in for one, each calling
 * `startResizeDragging`, which is `gtk_window_begin_resize_drag` underneath:
 * the window manager takes the pointer and does the rest. Measured under Xvfb
 * and openbox, all five drive a pixel-exact resize.
 *
 * **There is already a 5px border under this one, and it is not ours.**
 * tao 0.35.3 resizes an undecorated, resizable, unmaximised window from a
 * `scale_factor * 5`px border of its own, in GTK, below the DOM
 * (`platform_impl/linux/event_loop.rs`, `connect_button_press_event` →
 * `hit_test`) — and sets the resize cursor on motion while it is at it. So
 * these strips are not the difference between resizable and not. What they
 * add is the part that makes it usable: **16px bottom corners**, which are
 * the two people actually reach for and which tao gives 5px of; 6px rather
 * than 5 at the sides and the bottom. Both fire for a press within 5px of the
 * edge — one `begin_resize_drag` each, and no misbehaviour in any drag
 * measured.
 *
 * **There is nothing along the top, and that is the whole of this file's
 * history.** There used to be a 4px `North` strip and two 16x4 top corners.
 * They cost the top 4px of all three window buttons — `elementFromPoint` at
 * the centre of *Close*, 2px down, returned the strip, and the click did not
 * close the window — and they bought nothing, because tao's border is 5px and
 * a 4px strip sits entirely inside it. `hit_test` sets the `TOP` bit for
 * `cy < top + 5`, so every pixel those three strips covered was already
 * tao's, and tao's press handler returns `Propagation::Proceed`: it begins
 * its resize drag *and* lets the press through to the page, which is why a
 * click at `y=4` closed the window while the same click at `y=2` did not.
 * Only a DOM element on top of the button could swallow it, and that was
 * ours. So the top is tao's alone now, the buttons are clickable from their
 * first row down, and the reach at the top edge is unchanged.
 *
 * **Which leaves one thing the top corners cannot do, on purpose.** tao wins
 * every press in its own 5px, so a 16px-wide corner there would never have
 * resized diagonally beyond the first 5 of those pixels — measured: a pure
 * horizontal drag 8px in from the top-left moved nothing at all, and a
 * diagonal one moved only vertically, while the cursor said `nwse-resize`.
 * What is left is honest: in tao's 5x5 the cursor is diagonal and the drag
 * genuinely is (`hit_test` returns `TOPLEFT`), and across the rest of the top
 * edge both the cursor and the drag say top edge. **A diagonal drag from the
 * top corners is a 5px target, and that is as good as it gets without
 * beating tao to the press.** Dragging the bottom corners, or the top edge
 * and a side in turn, is the way to do it; the two bottom corners are 16px
 * for exactly that reason. `desktop/linux/README.md` says this where somebody
 * trying it on real hardware will read it.
 *
 * On Windows the same removal is right for the same reason and one more:
 * `platform_impl/windows/event_loop.rs`'s `WM_NCHITTEST` answers `HTTOP`
 * across the full width of the top `SM_CYFRAME` pixels of an undecorated
 * window with a shadow, which is what this one is — so the top edge is the
 * shell's there too, and *that* dead zone over the buttons is Windows',
 * pre-dates this file and is not ours to remove. The other five strips are
 * the only resize reach the sides and the bottom have on Windows at all,
 * because an undecorated shadowed window has no non-client area for the
 * system to put a border in.
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
 * - **6px** at the left, right and bottom, against tao's 5.
 * - **16px** corners, at the bottom only. The two people reach for.
 * - **Nothing above `y=4`** at the sides either, so the 6px the right-hand
 *   strip takes never reaches the row the window buttons are on.
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
/** Where the side strips start, which is below tao's 5px top border. */
const TOP = 4;
const CORNER = 16;

/* Edges first, corners second, so the corners paint over the ends of the
   edges rather than under them — a corner that loses to an edge is a corner
   that resizes one axis, which is the hardest kind of wrong to notice.

   **No `North`, `NorthWest` or `NorthEast`, deliberately.** The reason is the
   long one at the top of this file, and it is the kind of absence a
   well-meaning tidy-up completes: three of the eight directions are missing
   and the table looks unfinished. It is not. Anything drawn along the top is
   a dead zone over the window buttons in exchange for reach tao already has.

   Exported for the test that holds these numbers: they are the whole of the
   design here. */
export const STRIPS: { d: Direction; cursor: CSSProperties["cursor"]; box: CSSProperties }[] = [
  { d: "South", cursor: "ns-resize", box: { left: CORNER, right: CORNER, bottom: 0, height: EDGE } },
  { d: "West", cursor: "ew-resize", box: { top: TOP, bottom: CORNER, left: 0, width: EDGE } },
  { d: "East", cursor: "ew-resize", box: { top: TOP, bottom: CORNER, right: 0, width: EDGE } },
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
