/**
 * The bar ⌘F opens: a field, a count, and the three keys — ⏎ and ⇧⏎ to step
 * and wrap, esc to close.
 *
 * Drawn over the conversation (`FindInChat`) and over an artifact
 * (`ArtifactTab`), which search very different things in exactly the same
 * way, and should look it. What the bar knows nothing about is *where* the
 * matches are: the conversation walks its own text nodes, an artifact asks the
 * page in its frame to walk them. Whoever draws the bar owns the search and
 * hands back a count and the one that is lit.
 */
import { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { isMac } from "~/platform";

/**
 * Enough to light up a long document without walking a thousand ranges on
 * every keystroke. Past it, the answer is a longer query rather than more
 * highlights — so the count says `600+` and means it. The picker the control
 * plane injects into a page stops at the same number.
 */
export const CAP = 600;

/** How many there are, and which one is on. */
export type Found = { count: number; at: number };

/**
 * The count, as text.
 *
 * A count rather than a verdict: `none` is the honest word for a query that
 * matched nothing, `600+` for one that matched more than is worth lighting
 * up, and nothing at all while there is no query — or no answer yet, when the
 * search runs in another window and the reply has not come back.
 */
export function countOf(query: string, found: Found | null): string {
  if (!found || !query.trim()) return "";
  if (found.count === 0) return "none";
  return `${found.at + 1}/${found.count}${found.count >= CAP ? "+" : ""}`;
}

export function FindBar({
  query,
  onQuery,
  found,
  onStep,
  onClose,
  summoned,
  placeholder,
  disabled,
}: {
  query: string;
  onQuery: (q: string) => void;
  /** `null` while nothing has answered the query yet. */
  found: Found | null;
  /** Go to the next (`1`) or previous (`-1`) match. */
  onStep: (by: 1 | -1) => void;
  onClose: () => void;
  /** Bumped on every ⌘F, so a second press re-takes the field rather than doing nothing. */
  summoned: number;
  placeholder: string;
  /**
   * When the search cannot run and the bar should say so in the field rather
   * than take a query it would answer with nothing. The text is why.
   */
  disabled?: string;
}) {
  const field = useRef<HTMLInputElement>(null);

  /* ⌘F with the bar already up means "search again", not "nothing happens" —
     the field comes back with what is in it selected, ready to be typed over. */
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, [summoned]);

  const count = found?.count ?? 0;
  const label = countOf(query, found);

  return (
    <div className="absolute top-3 right-5 z-30 flex items-center gap-1.5 rounded-md border border-line bg-panel py-1 pr-1 pl-2.5 shadow-(--shadow-float)">
      <Search className="h-3.5 w-3.5 shrink-0 text-mute" strokeWidth={1.75} />
      <input
        ref={field}
        autoFocus
        value={query}
        disabled={!!disabled}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            /* The bar's own esc stops here. Whatever is around it — an
               expanded artifact, an annotating mode — has an esc of its own,
               and one press should close one thing. */
            e.stopPropagation();
            onClose();
          }
          if (e.key === "Enter") {
            e.preventDefault();
            onStep(e.shiftKey ? -1 : 1);
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            onStep(1);
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            onStep(-1);
          }
        }}
        placeholder={disabled ?? placeholder}
        title={disabled}
        className="w-52 min-w-0 bg-transparent text-meta text-bone placeholder:text-mute focus:outline-none disabled:placeholder:text-dim"
      />
      <span className={`w-16 shrink-0 text-right font-mono text-micro tabular-nums ${label === "none" ? "text-dim" : "text-mute"}`}>
        {label}
      </span>
      <button
        disabled={count === 0}
        onClick={() => onStep(-1)}
        title={`Previous  ${isMac ? "⇧⏎" : "Shift+⏎"}`}
        className="grid h-6 w-6 shrink-0 place-items-center rounded text-mute transition-colors hover:bg-raise hover:text-bone disabled:text-line"
      >
        <ChevronUp className="h-3.5 w-3.5" strokeWidth={2} />
      </button>
      <button
        disabled={count === 0}
        onClick={() => onStep(1)}
        title="Next  ⏎"
        className="grid h-6 w-6 shrink-0 place-items-center rounded text-mute transition-colors hover:bg-raise hover:text-bone disabled:text-line"
      >
        <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} />
      </button>
      <button
        onClick={onClose}
        title="Close  esc"
        className="grid h-6 w-6 shrink-0 place-items-center rounded text-mute transition-colors hover:bg-raise hover:text-bone"
      >
        <X className="h-3.5 w-3.5" strokeWidth={2} />
      </button>
    </div>
  );
}
