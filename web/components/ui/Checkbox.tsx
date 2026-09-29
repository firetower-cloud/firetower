"use client";

import { Check, Minus } from "lucide-react";
import { Icon } from "./Icon";

/**
 * A box that is ticked, empty, or partly ticked.
 *
 * Drawn rather than native. A platform checkbox cannot be brought into this
 * system — it arrives at the platform's size, with the platform's accent, and
 * on a dark ground it is the brightest thing on the screen, which is a job
 * already taken.
 *
 * `role="checkbox"` on a button rather than an `<input>`, because the mixed
 * state has to be announced and `indeterminate` is a DOM property that no
 * amount of markup can express — it can only be set from script, which makes
 * the element's own attributes a lie.
 *
 * Ticked is bone on ground: the same "this one" the rest of the system uses for
 * a selected segment, so selection reads the same everywhere.
 */
export function Checkbox({
  checked,
  indeterminate,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  /** Some of what this stands for, not all. Drawn as a dash. */
  indeterminate?: boolean;
  onChange: (checked: boolean) => void;
  /** For a screen reader. Every one of these sits beside a name it repeats. */
  label: string;
  disabled?: boolean;
}) {
  const on = checked || indeterminate;

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      aria-label={label}
      disabled={disabled}
      // Stops a row that is itself clickable from acting on the same click.
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      className={`grid h-4 w-4 shrink-0 place-items-center rounded-xs border transition-colors duration-150 ${
        disabled
          ? "cursor-not-allowed border-line-soft"
          : on
            ? "border-bone bg-bone text-ground"
            : "border-line hover:border-mute"
      }`}
    >
      {indeterminate ? (
        <Icon of={Minus} size={12} />
      ) : checked ? (
        <Icon of={Check} size={12} />
      ) : null}
    </button>
  );
}
