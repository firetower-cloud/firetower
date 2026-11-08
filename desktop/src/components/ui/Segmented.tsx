"use client";

import type { ReactNode } from "react";

/**
 * Two or three mutually exclusive things, one of them on.
 *
 * A recessed track with a raised knob — the artifact's `.seg`. The selected
 * segment lifts rather than inverting: at this size a filled bone block reads
 * as the page's primary action, which a filter is not.
 *
 * **It existed, was exported, and nothing imported it.** Three screens
 * hand-rolled `.track` instead — the appearance switch in the profile menu,
 * the preview's width picker and the style page's theme switch — and the
 * first of those drifted far enough that a user noticed it did not match.
 * That is the third component found complete and unreferenced, after
 * `Palette` and `Brand`. A component with no users is not a component; it is
 * a file that agrees with the design until somebody changes one of the
 * copies.
 *
 * A label may be a node, because one of those three picks widths with icons,
 * and an option may carry its own title for the same reason. Widening the
 * component is the fix; editing three call sites to look alike is not.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className = "",
  label,
}: {
  /** `[id, what it says, what it says on hover]`. */
  options: readonly (readonly [T, ReactNode, string?])[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  /** What the group is for, when the labels alone do not say. */
  label?: string;
}) {
  return (
    <div className={`seg shrink-0 ${className}`} role="group" aria-label={label}>
      {options.map(([id, says, hint]) => (
        <button
          key={id}
          type="button"
          aria-pressed={id === value}
          title={hint}
          onClick={() => onChange(id)}
          className="max-md:min-h-[44px]"
        >
          {says}
        </button>
      ))}
    </div>
  );
}
