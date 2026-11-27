"use client";

import { useState } from "react";
import { Check, ChevronDown, type LucideIcon } from "lucide-react";
import { Icon } from "./Icon";
import { Pop } from "~/ui/Pop";

/**
 * One of a few, chosen — what a `<select>` was for.
 *
 * **The primitive the desk did not have.** `Segmented` covers two or three
 * exclusive choices where all of them fit on a toolbar; `RowMenu` is a run of
 * *actions* a row offers. Neither is this: a control whose label *is the
 * current answer*, opening a list of the other answers. Usage wants five of
 * them at once — the grouping, the second level, the sort sentence, the scope
 * and the order of the limits — and every one of them was about to be the
 * same twenty lines of `.btn.plain` plus `Pop` plus `.mi`, which is the shape
 * `reuse.test.ts` exists to catch before the second copy drifts from the
 * first.
 *
 * It is assembled rather than invented, the way `RowMenu` was: `Pop` already
 * does the hard half — into `document.body`, flipped when the room below runs
 * out, capped to the room there is, closed by a scroll that moves what it is
 * pointing at — and `.mi` is already the row every menu in this window draws.
 * What was missing was the pair having a name.
 *
 * **The trigger says the answer, not the question.** `aria-label` carries the
 * question, so a screen reader hears *"Group by, by task"* rather than a
 * button whose only accessible name is whatever it happens to be set to this
 * minute. That is also why there is no visible label beside it: a toolbar of
 * five `Label: value` pairs is twice the width and says nothing the value does
 * not.
 *
 * **Never disabled.** A `Choose` with one option is a sentence, not a control,
 * and the caller draws the sentence — `config/Teams.tsx`' rule, which Usage's
 * fixed scope follows: a greyed control is how an interface says you are being
 * withheld from, and nothing is.
 */
export type Choice<T extends string> = {
  value: T;
  label: string;
  /** The part somebody would not have guessed, at the right of the row. */
  note?: string;
};

export function Choose<T extends string>({
  value,
  options,
  onChange,
  label,
  lead,
  testId,
  width = 248,
}: {
  value: T;
  options: Choice<T>[];
  onChange: (value: T) => void;
  /** What is being chosen, for a screen reader: "Group by", "Sort by". */
  label: string;
  /**
   * A glyph before the answer, for the one where the answer has a direction.
   *
   * Usage's sort folds the web's separate `DESC`/`ASC` pill into the sentence
   * — *most tokens first* — and the arrow is what makes that sentence
   * scannable at a glance without tracked-out capitals, which are banned.
   */
  lead?: LucideIcon;
  /** The `data-testid` the contract names this control by. */
  testId?: string;
  width?: number;
}) {
  const [open, setOpen] = useState<HTMLElement | null>(null);
  const current = options.find((o) => o.value === value);

  return (
    <>
      <button
        type="button"
        className="btn plain"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={!!open}
        data-testid={testId}
        /* `currentTarget` rather than a ref: the anchor `Pop` measures is the
           button that was pressed, and holding the element *is* holding the
           open state, so there is no second boolean to keep in step. */
        onClick={(e) => setOpen(open ? null : e.currentTarget)}
      >
        {lead && <Icon of={lead} size={14} />}
        <span className="min-w-0 truncate">{current?.label ?? value}</span>
        <span className="cv">
          <Icon of={ChevronDown} size={14} />
        </span>
      </button>
      {open && (
        <Pop anchor={open} onClose={() => setOpen(null)} width={width} align="left">
          <div className="scr min-h-0 overflow-y-auto">
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                /* `menuitemradio` rather than `option`: `Pop` is a `menu`, and
                   an `option` outside a `listbox` is a role nothing owns.
                   These are exclusive, so the radio flavour is the one that
                   says only one of them is on. */
                role="menuitemradio"
                aria-checked={o.value === value}
                aria-selected={o.value === value}
                className="mi"
                onClick={() => {
                  setOpen(null);
                  onChange(o.value);
                }}
              >
                <span className="tick">{o.value === value && <Icon of={Check} size={14} />}</span>
                <span className="sp">{o.label}</span>
                {o.note && <span className="note">{o.note}</span>}
              </button>
            ))}
          </div>
        </Pop>
      )}
    </>
  );
}
