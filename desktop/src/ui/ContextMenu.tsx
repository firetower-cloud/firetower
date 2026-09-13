/**
 * A menu at the pointer.
 *
 * One component under every right-click in the app, so they all open, move
 * and close the same way: at the pointer, clamped to the window; `↑`/`↓`
 * and `↵` on the keyboard; gone on `Esc`, a click anywhere else, or a
 * scroll — a menu that follows nothing should not outlive the thing it was
 * opened on.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type MenuItem = { label: string; shortcut?: string; tone?: "danger"; disabled?: boolean; onPick: () => void } | "-";
export type MenuAt = { x: number; y: number };

const W = 224;

export function ContextMenu({ at, items, onClose }: { at: MenuAt; items: MenuItem[]; onClose: () => void }) {
  const card = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ left: at.x, top: at.y });
  const [cursor, setCursor] = useState(-1);
  const picks = items.map((i, n) => (i !== "-" && !i.disabled ? n : -1)).filter((n) => n >= 0);

  useLayoutEffect(() => {
    const h = card.current?.offsetHeight ?? 200;
    setBox({
      left: Math.min(at.x, window.innerWidth - W - 8),
      top: at.y + h > window.innerHeight - 8 ? Math.max(8, at.y - h) : at.y,
    });
  }, [at]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => {
          const i = picks.indexOf(c);
          const next = e.key === "ArrowDown" ? picks[(i + 1) % picks.length] : picks[(i - 1 + picks.length) % picks.length];
          return next ?? c;
        });
      }
      if (e.key === "Enter" && cursor >= 0) {
        const item = items[cursor];
        if (item !== "-") {
          item.onPick();
          onClose();
        }
      }
    };
    const away = (e: MouseEvent) => {
      if (card.current && !card.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", away);
    document.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", away);
      document.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose, cursor, items, picks]);

  return (
    <div ref={card} role="menu" style={{ left: box.left, top: box.top, width: W }} onContextMenu={(e) => e.preventDefault()} className="fixed z-[55] overflow-hidden rounded-lg border border-line bg-overlay py-1 shadow-(--shadow-float)">
      {items.map((item, n) =>
        item === "-" ? (
          <div key={n} className="my-1 h-px bg-line-soft" />
        ) : (
          <button
            key={n}
            role="menuitem"
            disabled={item.disabled}
            onMouseEnter={() => setCursor(n)}
            onClick={() => {
              item.onPick();
              onClose();
            }}
            className={`flex w-full items-center gap-3 px-3 py-1.5 text-left text-ui transition-colors disabled:opacity-40 ${cursor === n ? "bg-raise" : ""} ${item.tone === "danger" ? "text-brick" : "text-text"}`}
          >
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.shortcut && <span className="shrink-0 font-mono text-micro text-mute">{item.shortcut}</span>}
          </button>
        ),
      )}
    </div>
  );
}

/** The state behind a right-click: where it happened, and on what. */
export function useMenu<T>() {
  const [open, setOpen] = useState<{ at: MenuAt; on: T } | null>(null);
  const show = (e: React.MouseEvent, on: T) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen({ at: { x: e.clientX, y: e.clientY }, on });
  };
  return { open, show, close: () => setOpen(null) };
}
