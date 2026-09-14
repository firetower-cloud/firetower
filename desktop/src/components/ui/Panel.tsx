/** A raised surface. Colour and a top highlight carry the lift, not a border. */
export function Panel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-lg border border-line bg-panel shadow-raise ${className}`}>
      {children}
    </div>
  );
}

/** The one heading on a page, and at most one line under it. */
export function PageHead({
  eyebrow,
  title,
  children,
  aside,
}: {
  eyebrow: string;
  title: React.ReactNode;
  children?: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    // Stacked below `sm`, because a heading and a button side by side at
    // 375px is a heading wrapped to four lines beside a button.
    <header className="mb-5 flex flex-col items-start gap-3 sm:flex-row sm:items-start sm:gap-4">
      <div className="min-w-0 flex-1">
        <div className="eyebrow">{eyebrow}</div>
        <h1 className="mt-1.5 text-display font-semibold text-bone">{title}</h1>
        {children && <p className="mt-1 max-w-[68ch] text-ui text-dim">{children}</p>}
      </div>
      {aside}
    </header>
  );
}
