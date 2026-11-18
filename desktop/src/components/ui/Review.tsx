"use client";

import type { ReactNode } from "react";

/**
 * A block that carries something to read before you act — the 2px rule.
 *
 * Not a filled panel and not a badge: it encodes *this one is different* and
 * spends two pixels doing it. The class has been in `styles.css` since the
 * skill review shipped and has been written out by hand at every call site
 * since; the Updates screen adds five more, which is the point at which it
 * stops being a class and becomes this.
 *
 * **The tone is a rule, not a decoration.** Amber means *read this before you
 * accept*, brick refuses, slate states a fact, sage reassures. The mark takes
 * the rule's hue so the block reads as one thing, which the sheet already
 * does by selector — the structure below is what that selector expects.
 *
 * Nothing here is ember. Ember answers one question, *is something waiting on
 * you*, and a block somebody is standing in front of is not it.
 */
export function Review({
  tone = "amber",
  mark,
  title,
  children,
  acts,
}: {
  tone?: "amber" | "brick" | "slate" | "sage";
  /** The glyph beside the heading. Takes the rule's hue from the sheet. */
  mark?: ReactNode;
  /** The sentence this block is about. Optional: some blocks are a paragraph. */
  title?: ReactNode;
  children: ReactNode;
  /** Buttons and a line of consequence, under the body. */
  acts?: ReactNode;
}) {
  return (
    <div className="review" data-tone={tone}>
      <div className="flex items-start gap-3">
        {mark && (
          <span className="mt-px shrink-0" aria-hidden>
            {mark}
          </span>
        )}
        <div className="min-w-0 flex-1">
          {title && <h3>{title}</h3>}
          {children}
        </div>
      </div>
      {acts && <div className="acts">{acts}</div>}
    </div>
  );
}
