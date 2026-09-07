/**
 * How much of something is being used.
 *
 * ## Why the colours are what they are
 *
 * Sage under two thirds, ember over it, brick when it is nearly gone — the
 * same three the rest of the interface already means "fine", "worth knowing"
 * and "this is the problem" by. A meter that were ember at every value would
 * say nothing; these say the one thing a person glancing at a row wants.
 *
 * ## A ceiling is not a total
 *
 * `limit` draws a notch, and it is deliberately not the same thing as `total`.
 * A workspace allowed 10 GB on a machine that has 20 is drawn against the 20,
 * with a mark where its own ceiling sits — because both facts matter and
 * showing only the ceiling hides that the machine has room, while showing only
 * the machine hides why the workspace stopped.
 *
 * With no `total` there is nothing to be a fraction of, so the bar is left out
 * and the label stands alone. That is the honest drawing for a worker that
 * cannot measure its machine: no meter rather than an empty one.
 */
export function Meter({
  used,
  total,
  limit,
  label,
  tone,
}: {
  used: number;
  total?: number;
  /** A ceiling inside the total, drawn as a notch. */
  limit?: number | null;
  label: string;
  /** Overrides the fraction-derived colour, for a bar that is already bad news. */
  tone?: "sage" | "ember" | "brick";
}) {
  const measurable = typeof total === "number" && total > 0;
  const fraction = measurable ? Math.min(used / total, 1) : 0;

  const chosen = tone ?? (fraction >= 0.9 ? "brick" : fraction >= 0.66 ? "ember" : "sage");
  const fill = {
    sage: "bg-sage",
    ember: "bg-ember",
    brick: "bg-brick",
  }[chosen];

  return (
    <span className="flex min-w-0 items-center gap-2.5">
      {measurable && (
        <span className="relative h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-line">
          <span
            className={`absolute inset-y-0 left-0 rounded-full ${fill}`}
            style={{ width: `${fraction * 100}%` }}
          />
          {/* Inside the bar rather than after it: a ceiling is a place along
              this axis, and a mark anywhere else would be a second scale to
              read. Hidden once it reaches the end, where it is the edge of the
              bar and drawing it adds a line that means nothing. */}
          {typeof limit === "number" && total && limit < total && (
            <span
              className="absolute inset-y-0 w-px bg-bone/70"
              style={{ left: `${Math.min(limit / total, 1) * 100}%` }}
            />
          )}
        </span>
      )}
      <span className="truncate font-mono text-meta text-dim">{label}</span>
    </span>
  );
}

/**
 * Megabytes as somebody would say them.
 *
 * Gigabytes once there are enough of them to be worth it, and one decimal
 * place at most — `6.2 GB` is a number you read, `6.23 GB` is one you parse,
 * and the difference is under a pixel of the bar beside it.
 */
export function size(mb: number | null | undefined): string {
  if (mb === null || mb === undefined) return "—";
  if (mb < 1024) return `${Math.round(mb)} MB`;
  const gb = mb / 1024;
  // No decimal past ten, where it is noise: `47 GB`, not `47.3 GB`.
  return `${gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`;
}
