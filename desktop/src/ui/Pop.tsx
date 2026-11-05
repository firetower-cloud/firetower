/**
 * A menu that gets out of whatever is clipping it.
 *
 * The rows live in an `overflow-y-auto` column inside a card that clips, and a
 * clipping ancestor clips whatever its descendants' `z-index` say — the sharing
 * sheet's level menu came out cut in half, and no stacking would have saved it.
 * So it is not a descendant: it goes into `document.body` at coordinates read
 * off the button, and flips above when the room below has run out.
 *
 * The price of coordinates is that they stop being true. Anything that could
 * move the button underneath it — a scroll, a resize — closes it rather than
 * leaving a menu pointing at nothing.
 *
 * **Here rather than in one screen** because the second one to need it got it
 * wrong in exactly the same way: the git hosts list put a row menu inside
 * `Section`'s card and it came out clipped at the bottom edge. One of these,
 * imported twice.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** How far the card keeps off the window edge, and off the button it drops from. */
const EDGE = 8;
const GAP = 4;

/** Where the card lands, and the height it has to live in. */
export type Spot = {
  left: number;
  /** Exactly one of these. `bottom` is how a flipped menu stays put — see `place`. */
  top?: number;
  bottom?: number;
  /** The room there was. The card may not exceed it, so it is always on screen. */
  room: number;
};

/**
 * Which side of the button the menu opens on, and how tall it may be.
 *
 * Two bugs lived in one line here, and the same screenshot showed both: the
 * repository menu was taller than the room above the pill, so it ran off the
 * top of the window, and nothing capped its height, so the rows past the edge
 * were simply unreachable. Flipping without clamping only moves which end of
 * the list you cannot get to.
 *
 * So the chosen side is the one with more room, and `room` is what the card is
 * then capped at — which is what makes it fit rather than merely aimed at the
 * right half of the screen. The flipped card is anchored by its **bottom**
 * edge: a list being filtered as somebody types changes height under them, and
 * a top-anchored one would walk away from the button it dropped from.
 */
export function place(
  to: { top: number; bottom: number; right: number },
  card: { width: number; height: number },
  view: { width: number; height: number },
): Spot {
  const below = view.height - to.bottom - GAP - EDGE;
  const above = to.top - GAP - EDGE;
  // Below unless it does not fit and above is roomier — so a menu that fits
  // keeps dropping downward, which is where a menu is looked for.
  const up = card.height > below && above > below;
  return {
    left: Math.max(EDGE, to.right - card.width),
    ...(up ? { bottom: view.height - to.top + GAP } : { top: to.bottom + GAP }),
    room: Math.max(0, up ? above : below),
  };
}

/**
 * Whether a scroll came from inside the menu itself.
 *
 * `scroll` does not bubble, so the only way to hear an *ancestor* scrolling —
 * the thing that invalidates the coordinates — is to capture at the window,
 * which hears every scroller in the document including the menu's own list.
 * That is the whole bug: scrolling the repository list closed it.
 *
 * `e.target` for a scroll is the `Document` when the page itself moved, which
 * is an ancestor of the menu rather than a descendant, so `contains` answers
 * correctly. It is still asked whether it is a node at all, because `contains`
 * takes one and the target of a scroll is not guaranteed to be anything in
 * particular.
 */
export function fromInside(target: EventTarget | null, menu: Node | null): boolean {
  const node = target as Node | null;
  return typeof node?.nodeType === "number" && !!menu?.contains(node);
}

export function Pop({
  anchor,
  onClose,
  children,
  width,
}: {
  anchor: HTMLElement;
  onClose: () => void;
  children: React.ReactNode;
  /** A fixed width, for a menu that should match whatever it drops from — a
   *  field-wide select rather than a small row menu. Defaults to `w-44`. */
  width?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [spot, setSpot] = useState<Spot | null>(null);

  // Measured rather than guessed, so the flip keeps working when the menu is
  // four rows instead of three. The first pass is unconstrained — no `room`
  // has been set yet — so what is measured is the height the card wants.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setSpot(
      place(
        anchor.getBoundingClientRect(),
        { width: el.offsetWidth, height: el.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [anchor]);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      // Not the button, which toggles itself: closing here first would let its
      // own click reopen what it meant to shut.
      if (!box.current?.contains(t) && !anchor.contains(t)) onClose();
    };
    // Captured at the document, which runs before the sheet's own Escape on the
    // window — otherwise dismissing this menu threw the whole sheet away.
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    /* An ancestor scrolling moves the button and the menu does not follow, so
       it closes. The menu scrolling its own list is the menu working. */
    const scrolled = (e: Event) => {
      if (!fromInside(e.target, box.current)) onClose();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key, true);
    window.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", onClose);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={box}
      role="menu"
      style={{
        position: "fixed",
        top: spot ? spot.top : -9999,
        bottom: spot?.bottom,
        left: spot ? spot.left : -9999,
        width,
        maxHeight: spot?.room,
      }}
      /* A column, because `room` is a cap on the card and the list inside has
         to give way to it — a `min-h-0` scrolling child shrinks to what is
         left while a search header above it stays put. That is the flexbox
         rule in STYLE.md, and the reason the header is not in the scroller.

         `overflow-y-auto` rather than `hidden` is for the menus with no
         scroller of their own: a short window caps them too, and a row that
         has been clipped off the bottom of the card is exactly as unreachable
         as one that ran off the window. A menu whose list does scroll never
         reaches this, so its header still does not move. */
      className={`scroll-slim z-[70] flex flex-col overflow-x-hidden overflow-y-auto rounded-lg border border-line bg-panel shadow-(--shadow-float) ${
        width == null ? "w-44" : ""
      } ${spot ? "" : "invisible"}`}
    >
      {children}
    </div>,
    document.body,
  );
}
