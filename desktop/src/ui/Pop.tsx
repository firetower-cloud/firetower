/**
 * A menu that gets out of whatever is clipping it.
 *
 * The rows live in an `overflow-y-auto` column inside an `overflow-hidden`
 * card, and a clipping ancestor clips whatever its descendants' `z-index` say
 * — the sharing sheet's level menu came out cut in half, and no stacking would
 * have saved it. So it is not a descendant: it goes into `document.body` at
 * coordinates read off the button, and flips above when the room below has run
 * out.
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

export function Pop({
  anchor,
  onClose,
  children,
}: {
  anchor: HTMLElement;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);

  // Measured rather than guessed, so the flip keeps working when the menu is
  // four rows instead of three.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const to = anchor.getBoundingClientRect();
    setAt({
      top:
        window.innerHeight - to.bottom - 8 < el.offsetHeight
          ? to.top - el.offsetHeight - 4
          : to.bottom + 4,
      left: Math.max(8, to.right - el.offsetWidth),
    });
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
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key, true);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={box}
      role="menu"
      style={{ position: "fixed", top: at?.top ?? -9999, left: at?.left ?? -9999 }}
      className={`z-[70] w-44 overflow-hidden rounded-lg border border-line bg-panel shadow-(--shadow-float) ${
        at ? "" : "invisible"
      }`}
    >
      {children}
    </div>,
    document.body,
  );
}
