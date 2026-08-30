"use client";

/**
 * A file, as a name and where it lives.
 *
 * Every list in the panel is the same row three times — the tree, the changes,
 * the files going into a commit — and all three used to draw the whole path as
 * one dim mono string, truncated in the middle of whichever part mattered.
 *
 * A path answers two questions and they deserve different weights: *which file*
 * is the name, and it is what somebody is scanning for; *which one of the four
 * called `index.ts`* is the directory, and it only matters once the name has
 * already matched. Bright name, dim directory, and the directory is what gets
 * dropped when the row runs out of room.
 */
export function PathRow({
  path,
  lead,
  trail,
  on = false,
  onClick,
  title,
}: {
  path: string;
  /** A glyph, a checkbox, a status dot — whatever the list uses. */
  lead?: React.ReactNode;
  /** Counts, an action, whatever goes on the right. */
  trail?: React.ReactNode;
  /** Whether this is the row the middle is showing. */
  on?: boolean;
  onClick?: () => void;
  title?: string;
}) {
  const cut = path.lastIndexOf("/");
  const name = cut === -1 ? path : path.slice(cut + 1);
  const dir = cut === -1 ? "" : path.slice(0, cut);

  return (
    <div
      className={`group flex items-center gap-2 rounded-sm px-1.5 py-1 transition-colors ${
        on ? "bg-raise" : "hover:bg-raise/60"
      }`}
    >
      {lead}

      <button
        onClick={onClick}
        title={title ?? path}
        disabled={!onClick}
        className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left disabled:cursor-default"
      >
        <span
          className={`shrink-0 truncate font-mono text-meta transition-colors ${
            on ? "text-bone" : "text-dim group-hover:text-bone"
          }`}
        >
          {name}
        </span>
        {/* Shrinks first and disappears last: it is the half that stops
            mattering once the name has been read. */}
        {dir && (
          <span className="min-w-0 flex-1 truncate font-mono text-micro text-mute">{dir}</span>
        )}
      </button>

      {trail}
    </div>
  );
}

/** `+12 −3`, drawn the same way everywhere it appears. */
export function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="flex shrink-0 items-baseline gap-1 font-mono text-micro">
      <span className="text-sage">+{added}</span>
      <span className="text-brick">−{removed}</span>
    </span>
  );
}

/**
 * A section that folds, with a count.
 *
 * `GOING IN 3` rather than a bare heading: the count is what tells you whether
 * folding it would hide anything, which is the only reason to look at a heading
 * you have already read once.
 */
export function Fold({
  label,
  count,
  open,
  onToggle,
  children,
}: {
  label: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="min-h-0">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 px-1.5 py-1.5 text-left"
      >
        <span
          className="shrink-0 text-micro text-mute transition-transform"
          style={{ transform: open ? "rotate(90deg)" : undefined }}
        >
          ▸
        </span>
        <span className="eyebrow">{label}</span>
        {count !== undefined && (
          <span className="ml-auto font-mono text-micro text-mute">{count}</span>
        )}
      </button>
      {open && children}
    </section>
  );
}
