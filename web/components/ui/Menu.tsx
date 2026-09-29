"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, MoreHorizontal } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Icon } from "./Icon";

/**
 * A list of things to do, over whatever is underneath.
 *
 * **Why this exists rather than a `<select>` or a row of buttons.** Four named
 * actions written out at the end of every row is four times the ink of the
 * thing the row is about, and it grows with the number of things anybody can
 * do. A platform `<select>` has the same problem from the other end: it renders
 * as the platform draws it, at the platform's size, so a long label makes a
 * wide control and the popup belongs to the operating system rather than to
 * this screen.
 *
 * **Drawn on `body`.** Same reason as `Modal`: `position: fixed` stops being
 * relative to the viewport the moment any ancestor has a transform, a filter or
 * containment — and this is opened from inside scrolling panels and animated
 * rails. Portalling is the fix that keeps working.
 *
 * Placed from the trigger's own rectangle, and flipped above it when there is
 * not room below, so a menu on the last row of a table opens onto the screen
 * rather than off the bottom of it.
 */
export type Item<T = never> =
  | { separator: true }
  | {
      label: string;
      onClick: () => void;
      icon?: LucideIcon;
      /** The destructive one. There is at most one per menu. */
      danger?: boolean;
      disabled?: boolean;
      /** Drawn with a tick, for a menu that is answering a question. */
      chosen?: boolean;
      /** A second line, when the label alone does not say what it costs. */
      note?: string;
      value?: T;
    };

/** Where a menu can go, measured from the trigger. */
type At = { left: number; top: number; width: number; flip: boolean };

function useAnchor(open: boolean) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<At | null>(null);

  // Before paint, so the menu is never drawn at the wrong place first and
  // corrected after — which reads as a flicker at exactly the moment somebody
  // is looking at it.
  //
  // A closed menu keeps the last rectangle rather than clearing it. Clearing
  // would be a `setState` in an effect for a value nothing reads while closed —
  // one more render, on every close, to arrive at a state indistinguishable
  // from the one before it. Reopening measures again before paint anyway.
  useLayoutEffect(() => {
    if (!open) return;

    const place = () => {
      const box = trigger.current?.getBoundingClientRect();
      if (!box) return;
      setAt({
        left: box.left,
        top: box.bottom + 4,
        width: box.width,
        // 260px is a menu of about six items. Below that much room, open
        // upwards instead.
        flip: window.innerHeight - box.bottom < 260,
      });
    };

    place();
    // Capture, so a scroll inside any panel moves it and not only the window's.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  return { trigger, at };
}

function Surface({
  at,
  items,
  onClose,
  minWidth,
}: {
  at: At;
  items: Item[];
  onClose: () => void;
  minWidth: number;
}) {
  return createPortal(
    <>
      {/* Catches the click that closes it, including one on the trigger. */}
      <div className="fixed inset-0 z-[60]" onClick={onClose} onContextMenu={onClose} />
      <div
        role="menu"
        style={{
          left: Math.min(at.left, Math.max(8, window.innerWidth - minWidth - 8)),
          ...(at.flip ? { bottom: window.innerHeight - at.top + 8 } : { top: at.top }),
          minWidth,
        }}
        className="fixed z-[61] overflow-hidden rounded-md border border-line bg-overlay py-1 shadow-float"
      >
        {items.map((item, i) =>
          "separator" in item ? (
            <div key={i} className="my-1 h-px bg-line" />
          ) : (
            <button
              key={i}
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                onClose();
                item.onClick();
              }}
              className={`flex w-full items-center gap-3 px-3 py-1.5 text-left text-ui transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${
                item.danger
                  ? "text-brick hover:bg-brick-tint"
                  : "text-text hover:bg-raise hover:text-bone"
              }`}
            >
              {item.icon && (
                <span className="shrink-0 text-mute">
                  <Icon of={item.icon} size={14} />
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate">{item.label}</span>
                {item.note && <span className="block text-meta text-mute">{item.note}</span>}
              </span>
              <span className="w-3 shrink-0 text-bone">
                {item.chosen && <Icon of={Check} size={12} />}
              </span>
            </button>
          ),
        )}
      </div>
    </>,
    document.body,
  );
}

/** Escape closes it, wherever the focus is. */
function useEscape(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, close]);
}

/**
 * The overflow menu at the end of a row: everything that can be done to one
 * thing, behind one glyph.
 */
export function RowMenu({ items, label = "More" }: { items: Item[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const { trigger, at } = useAnchor(open);
  useEscape(open, () => setOpen(false));

  if (items.length === 0) return null;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`grid h-7 w-7 shrink-0 place-items-center rounded-md transition-colors duration-150 max-md:h-11 max-md:w-11 ${
          open ? "bg-raise text-bone" : "text-mute hover:bg-raise hover:text-bone"
        }`}
      >
        <Icon of={MoreHorizontal} size={16} />
      </button>
      {open && at && (
        <Surface at={at} items={items} minWidth={200} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

/**
 * A named button that opens a menu.
 *
 * `RowMenu` is the same thing behind a glyph, for the end of a row where the
 * actions are obvious from the row. This one is for an action that has to say
 * what it is before it can be found — "Move to…", where the menu is the list of
 * somewheres.
 */
export function MenuButton({
  label,
  items,
  disabled,
  size = "md",
}: {
  label: string;
  items: Item[];
  disabled?: boolean;
  size?: "sm" | "md";
}) {
  const [open, setOpen] = useState(false);
  const { trigger, at } = useAnchor(open);
  useEscape(open, () => setOpen(false));

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled || items.length === 0}
        onClick={() => setOpen((o) => !o)}
        className={`flex shrink-0 items-center gap-1.5 rounded-md border border-line bg-raise text-text shadow-raise transition-colors duration-150 hover:bg-overlay hover:text-bone disabled:cursor-not-allowed disabled:text-mute ${
          size === "sm" ? "h-7 px-2.5 text-meta max-md:min-h-[44px]" : "h-8 px-3 text-ui max-md:min-h-[44px]"
        }`}
      >
        {label}
        <span className="text-mute">
          <Icon of={ChevronDown} size={12} />
        </span>
      </button>
      {open && at && (
        <Surface at={at} items={items} minWidth={210} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

/**
 * One of a few, chosen — what a `<select>` was for.
 *
 * The trigger says the current answer in the screen's own type, and the list
 * that opens is this system's menu rather than the platform's. `note` on an
 * option is a second line for a choice that needs one — most do not, and a note
 * under every option is furniture.
 */
export function Choose<T extends string>({
  value,
  options,
  onChange,
  disabled,
  label,
  align = "left",
}: {
  value: T;
  options: { value: T; label: string; note?: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  label: string;
  /** `right` for the last column of a table, where the trigger hugs the edge. */
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const { trigger, at } = useAnchor(open);
  useEscape(open, () => setOpen(false));

  const current = options.find((o) => o.value === value);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={`flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-ui transition-colors duration-150 disabled:cursor-not-allowed disabled:text-mute ${
          align === "right" ? "justify-between" : ""
        } ${
          open
            ? "border-mute bg-raise text-bone"
            : "border-line text-text hover:border-mute/60 hover:text-bone"
        }`}
      >
        <span className="truncate">{current?.label ?? value}</span>
        <span className="shrink-0 text-mute">
          <Icon of={ChevronDown} size={12} />
        </span>
      </button>
      {open && at && (
        <Surface
          at={at}
          minWidth={Math.max(at.width, 210)}
          onClose={() => setOpen(false)}
          items={options.map((o) => ({
            label: o.label,
            note: o.note,
            chosen: o.value === value,
            onClick: () => onChange(o.value),
          }))}
        />
      )}
    </>
  );
}
