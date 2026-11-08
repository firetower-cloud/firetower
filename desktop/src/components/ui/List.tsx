import Link from "~/shims/next-link";

/**
 * A list of things, all at the same rhythm.
 *
 * Rows are 60px and separated by a hairline that stops at the container edge —
 * not a box drawn around each one. What makes a list read as a list is the
 * repeat, and every border added is one more thing competing with it.
 */
export function List({
  children,
  /** Inside a card that already draws the border and the ground. */
  flush,
}: {
  children: React.ReactNode;
  flush?: boolean;
}) {
  const rows = <div className="divide-y divide-line-soft">{children}</div>;
  if (flush) return rows;

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-panel shadow-raise">
      {rows}
    </div>
  );
}

/** The map legend above a list. Nothing else in the app uses this voice. */
export function Columns({ children }: { children: React.ReactNode }) {
  return (
    <div className="legend flex items-center gap-3 border-b border-line bg-raise/40 px-4 py-2">
      {children}
    </div>
  );
}

const ROW =
  "group flex min-h-[60px] items-center gap-3 px-4 transition-colors duration-150 hover:bg-raise";

export function Row({
  children,
  onClick,
  href,
  lead,
  className = "",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  /** A whole row that goes somewhere, rather than one with buttons in it. */
  href?: string;
  /**
   * A control that belongs to the row rather than to where it leads.
   *
   * Rendered outside the link on purpose. A checkbox nested inside an anchor
   * is invalid, and making it behave means cancelling the click — which
   * cancels the checkbox's own toggle along with the navigation, so the box
   * never ticks.
   */
  lead?: React.ReactNode;
  className?: string;
}) {
  if (href) {
    return (
      <div className={`${ROW} ${className}`}>
        {lead}
        <Link href={href} className="flex min-w-0 flex-1 items-center gap-3">
          {children}
        </Link>
      </div>
    );
  }

  return (
    <div onClick={onClick} className={`${ROW} ${className}`}>
      {children}
    </div>
  );
}

/* ── What a list says when it has nothing to say ───────────────────────
   **`Empty` is gone, and it was the dashed box.** A dashed border round
   nothing says *drop something here* or *this failed to load*, and it was the
   only border on the page, which made the void the loudest object on it. No
   screen in `desktop/src` ever pointed at it. There are two shapes for an
   empty list now and both live in `ui/config/bits.tsx`: `Blank` for a page
   whose body has nothing in it, and `Note` for a page that has content, one
   part of which is empty.

   `web/components/ui/List.tsx` keeps its twin until the web client is done. */
