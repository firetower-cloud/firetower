/**
 * A raised block of related things.
 *
 * **Not a frame around a list.** Rows belong on the sheet itself — see `.lsec`
 * and `.r` in `styles.css`, which is the shape eleven configuration screens
 * take. A card is for a block that is one object: a plan, a repository being
 * shipped, a set of facts.
 */
export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`overflow-hidden rounded-2xl bg-raise ${className}`}>{children}</div>
  );
}

export function CardHead({
  children,
  /** Pushed to the right of the controls — a count, usually. */
  aside,
  /** A line under the controls, for what the controls came to. */
  note,
}: {
  children: React.ReactNode;
  aside?: React.ReactNode;
  note?: React.ReactNode;
}) {
  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        {children}
        {aside && <div className="ml-auto flex shrink-0 items-center">{aside}</div>}
      </div>
      {note && <div className="mt-2.5">{note}</div>}
    </div>
  );
}
