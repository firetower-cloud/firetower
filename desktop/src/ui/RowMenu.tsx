/**
 * The menu a row carries, anchored to the row.
 *
 * **The one primitive this client genuinely lacked.** `ContextMenu` is the
 * nearest thing and is not it: it opens *at the pointer*, which is right for a
 * right-click and wrong for a button — a card that appears under the cursor
 * rather than under the control you pressed leaves nothing on screen saying
 * which row it belongs to, and there is no way to reach it from the keyboard
 * at all. This opens from the button, which is the thing that says what it is
 * about.
 *
 * It is assembled rather than invented. `Pop` already does the hard half —
 * into `document.body`, flipped when the room below runs out, capped to the
 * room there is, closed by a scroll that moves what it is pointing at — and
 * `.mi` is already the menu row every other menu in the window draws. What was
 * missing was a name for the pair, so that the next screen does not rebuild
 * it: the git hosts list built exactly this inline and the people list would
 * have been the second copy, with its own `MenuItem` drifting a half-pixel
 * from the first one. That is the shape `reuse.test.ts` was written about.
 *
 * **The button lives in `.hov`**, so it arrives on hover *and on focus* —
 * `.r:hover .hov` and the focus ring between them, or the keyboard is told
 * less than the mouse. A row with nothing to offer draws no button at all,
 * rather than an empty menu or a greyed one: a control somebody does not have
 * is not drawn.
 */
import { useState } from "react";
import { MoreHorizontal, type LucideIcon } from "lucide-react";
import { Icon, IconButton } from "~/components/ui";
import { Pop } from "~/ui/Pop";

export type RowMenuItem =
  | {
      label: string;
      /** The glyph at 14, which is `.mi .ic`'s size everywhere else. */
      icon?: LucideIcon;
      /** The part somebody would not have guessed — "Keeps what they made". */
      note?: string;
      /** Brick, for the one that destroys something. */
      tone?: "danger";
      disabled?: boolean;
      onPick: () => void;
    }
  /** A rule. Never first, never last — the caller decides where it goes. */
  | "-";

export function RowMenu({
  label,
  items,
  width = 232,
}: {
  /** What this menu is *about*, named for a screen reader: "What to do with ana". */
  label: string;
  items: RowMenuItem[];
  width?: number;
}) {
  const [open, setOpen] = useState<HTMLElement | null>(null);
  /* Nothing to offer, nothing drawn. The alternative — a ⋯ that opens on an
     empty card — is the same lie as a disabled control, told one click later. */
  if (items.filter((i) => i !== "-").length === 0) return null;

  return (
    /* A positioned wrapper so the row's flex layout sees one child, the way
       the git hosts row does. `Pop` is portalled, so this box never grows. */
    <div>
      <IconButton
        of={MoreHorizontal}
        onClick={(e) => setOpen(open ? null : e.currentTarget)}
        label={label}
        className="hov"
      />
      {open && (
        <Pop anchor={open} onClose={() => setOpen(null)} width={width}>
          <div className="py-1">
            {items.map((item, n) =>
              item === "-" ? (
                <span key={n} className="mline" aria-hidden />
              ) : (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  data-tone={item.tone}
                  onClick={() => {
                    setOpen(null);
                    item.onPick();
                  }}
                  className="mi disabled:opacity-40"
                >
                  <span className="ic">{item.icon && <Icon of={item.icon} size={14} />}</span>
                  <span className="tx">
                    <b>{item.label}</b>
                    {item.note && <s>{item.note}</s>}
                  </span>
                </button>
              ),
            )}
          </div>
        </Pop>
      )}
    </div>
  );
}
