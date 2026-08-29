/**
 * A list and the controls that decide what is in it, as one thing.
 *
 * The controls were a loose row of buttons floating above a bordered list,
 * which reads as two unrelated pieces of furniture — and the line saying what
 * was actually asked for sat between them belonging to neither. Inside one
 * card, with a hairline under the header, the question and the answer are
 * plainly the same object.
 */
export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`overflow-hidden rounded-lg border border-line bg-panel shadow-raise ${className}`}
    >
      {children}
    </div>
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
    <div className="border-b border-line px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        {children}
        {aside && <div className="ml-auto flex shrink-0 items-center">{aside}</div>}
      </div>
      {note && <div className="mt-2.5">{note}</div>}
    </div>
  );
}
