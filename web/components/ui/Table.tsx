"use client";

import { X } from "lucide-react";
import { Icon } from "./Icon";

/**
 * Rows of the same shape, with a legend over them.
 *
 * A real `<table>`, unlike `List` beside it, and the difference is the point:
 * `List` is for things of one kind where the name is most of the row, and this
 * is for things with the *same fields* — a role, a count, a state — which have
 * to line up down the page or they cannot be compared. Flexbox rows cannot
 * promise that; a column can.
 *
 * Scrolls sideways rather than wrapping. A table squeezed until its columns
 * wrap stops being a table.
 */
export function Table({ children }: { children: React.ReactNode }) {
  return (
    <div className="scroll-slim overflow-x-auto">
      <table className="w-full border-collapse text-ui">{children}</table>
    </div>
  );
}

/** The map legend. Same voice as `Columns` over a list — nothing else uses it. */
export function Head({ children }: { children: React.ReactNode }) {
  return (
    <thead>
      <tr className="border-b border-line bg-raise/40">{children}</tr>
    </thead>
  );
}

export function HeadCell({
  children,
  right,
  /** `tight` is a column that should take no more room than its contents. */
  tight,
  className = "",
}: {
  children?: React.ReactNode;
  right?: boolean;
  tight?: boolean;
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={`px-3 py-2 font-narrow text-micro font-semibold tracking-[0.14em] text-mute uppercase first:pl-4 last:pr-4 ${
        right ? "text-right" : "text-left"
      } ${tight ? "w-px whitespace-nowrap" : ""} ${className}`}
    >
      {children}
    </th>
  );
}

export function Body({ children }: { children: React.ReactNode }) {
  return <tbody className="divide-y divide-line-soft">{children}</tbody>;
}

/**
 * Selected is a lift, not a tint.
 *
 * Colour is fully spent in this system, and a selected row is not a *state* of
 * the thing — it is a fact about what you are about to do to it. A step up the
 * ground scale says that without spending a hue, and it stacks with hover
 * instead of fighting it.
 */
export function Row({
  children,
  selected,
  muted,
}: {
  children: React.ReactNode;
  selected?: boolean;
  /** Switched off, or otherwise present but not participating. */
  muted?: boolean;
}) {
  return (
    <tr
      className={`group transition-colors duration-150 ${
        selected ? "bg-raise" : "hover:bg-raise/50"
      } ${muted ? "opacity-55" : ""}`}
    >
      {children}
    </tr>
  );
}

export function Cell({
  children,
  right,
  tight,
  className = "",
}: {
  children?: React.ReactNode;
  right?: boolean;
  tight?: boolean;
  className?: string;
}) {
  return (
    <td
      className={`px-3 py-3.5 align-middle first:pl-4 last:pr-4 ${right ? "text-right" : ""} ${
        tight ? "w-px whitespace-nowrap" : ""
      } ${className}`}
    >
      {children}
    </td>
  );
}

/**
 * What can be done to everything ticked.
 *
 * Takes the place of the toolbar rather than appearing beside it. Two rows of
 * controls — one about the list, one about the selection — is two questions
 * asked at once, and the answer to the second is the only one anybody is
 * looking for while something is ticked.
 *
 * The count is the first thing in it, because the whole risk of a grouped
 * action is doing it to more rows than you meant.
 */
export function Bulk({
  count,
  onClear,
  children,
  what = "selected",
}: {
  count: number;
  onClear: () => void;
  /** The actions. Buttons at `sm`, in the order they are likely to be wanted. */
  children: React.ReactNode;
  /** The noun, when "3 selected" is vaguer than it needs to be. */
  what?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-raise px-4 py-2.5">
      <span className="text-ui font-medium text-bone">
        {count} {what}
      </span>
      <button
        type="button"
        onClick={onClear}
        className="flex items-center gap-1 rounded-sm px-1 text-meta text-mute transition-colors hover:text-bone"
      >
        <Icon of={X} size={12} />
        Clear
      </button>
      <div className="ml-auto flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}
