/**
 * Every server's work, in one list.
 *
 * This screen does not exist in `web/` and could not: it is the first thing that
 * is true only once a client holds N backends. It is also where the design risk
 * lives — a merged list is the strongest expression of the thesis and the most
 * likely to feel chaotic — so it is built both ways behind one switch, and the
 * comparison is the point.
 */
import { useMemo, useState } from "react";
import { ChevronRight, CircleDashed, CircleSlash2 } from "lucide-react";
import { BACKENDS, type Backend } from "~/mock/backends";
import { useInbox, NEEDS_YOU, IN_FLIGHT, type Row } from "~/backend";

type Sort = "waiting" | "server";

const elapsed = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
};

/** Waiting first, then in flight, then the rest — each by how long. */
function rank(r: Row) {
  if (NEEDS_YOU.has(r.status)) return 0;
  if (IN_FLIGHT.has(r.status)) return 1;
  return 2;
}

export function Inbox({
  scope,
  selected,
  onSelect,
}: {
  scope: string;
  selected?: string;
  onSelect: (id: string) => void;
}) {
  const { rows } = useInbox();
  const [sort, setSort] = useState<Sort>("waiting");

  const visible = useMemo(
    () => rows.filter((r) => scope === "all" || r.backend.id === scope),
    [rows, scope],
  );

  const merged = useMemo(
    () =>
      [...visible].sort(
        (a, b) => rank(a) - rank(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
      ),
    [visible],
  );

  const grouped = useMemo(() => {
    const out: { backend: Backend; rows: Row[] }[] = [];
    for (const b of BACKENDS) {
      const mine = merged.filter((r) => r.backend.id === b.id);
      if (mine.length) out.push({ backend: b, rows: mine });
    }
    return out;
  }, [merged]);

  const waiting = merged.filter((r) => NEEDS_YOU.has(r.status)).length;

  return (
    <div className="flex h-full w-[300px] shrink-0 flex-col border-r border-line bg-(--color-panel-vibrant)">
      <header className="flex h-9 shrink-0 items-center justify-between px-3">
        <span className="eyebrow">{scope === "all" ? "Inbox" : BACKENDS.find((b) => b.id === scope)?.org}</span>
        {waiting > 0 && (
          <span className="rounded-full border border-ember-deep bg-ember-tint px-1.5 text-meta font-semibold text-ember-soft">
            {waiting} waiting
          </span>
        )}
      </header>

      {/* The open question, made switchable rather than guessed at. */}
      {scope === "all" && (
        <div className="flex shrink-0 gap-1 px-2 pb-2">
          {(["waiting", "server"] as Sort[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSort(s)}
              className={`rounded-sm px-2 py-1 text-meta transition-colors ${
                sort === s ? "bg-overlay text-bone" : "text-mute hover:bg-raise hover:text-dim"
              }`}
            >
              {s === "waiting" ? "By wait" : "By server"}
            </button>
          ))}
        </div>
      )}

      <div className="scroll-slim min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {scope !== "all" || sort === "waiting" ? (
          merged.map((r) => (
            <Line key={r.id} row={r} on={r.id === selected} showMark={scope === "all"} onPick={() => onSelect(r.id)} />
          ))
        ) : (
          grouped.map(({ backend, rows }) => (
            <section key={backend.id} className="mb-2">
              <div className="flex items-center gap-1.5 px-2 pt-2 pb-1">
                <span className="eyebrow">{backend.org}</span>
                {backend.reach === "unreachable" && (
                  <CircleSlash2 className="h-3 w-3 text-mute" strokeWidth={2} />
                )}
              </div>
              {rows.map((r) => (
                <Line key={r.id} row={r} on={r.id === selected} showMark={false} onPick={() => onSelect(r.id)} />
              ))}
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function Line({
  row,
  on,
  showMark,
  onPick,
}: {
  row: Row;
  on: boolean;
  showMark: boolean;
  onPick: () => void;
}) {
  const needs = NEEDS_YOU.has(row.status);
  const flight = IN_FLIGHT.has(row.status);
  const dark = row.backend.reach === "unreachable";

  return (
    <button
      type="button"
      onClick={onPick}
      data-on={on}
      className={`row w-full text-left ${dark ? "stale" : ""}`}
      style={{ gridTemplateColumns: showMark ? "18px 1fr auto" : "10px 1fr auto" }}
    >
      {showMark ? (
        <span className="text-micro font-bold text-mute" style={{ fontFamily: "var(--font-narrow)" }}>
          {row.backend.mark}
        </span>
      ) : (
        <Dot needs={needs} flight={flight} />
      )}

      <span className="min-w-0">
        <span className={`block truncate text-ui ${needs ? "text-bone" : on ? "text-text" : "text-dim"}`}>
          {row.name}
        </span>
      </span>

      <span className="flex items-center gap-1.5">
        {needs && !dark && <span className="h-1.5 w-1.5 rounded-full bg-ember" />}
        {flight && !dark && <CircleDashed className="h-3 w-3 animate-spin text-slate" strokeWidth={2} style={{ animationDuration: "2.4s" }} />}
        <span className="text-meta tabular-nums text-mute">{elapsed(row.updatedAt)}</span>
        <ChevronRight className={`h-3 w-3 ${on ? "text-dim" : "text-transparent"}`} strokeWidth={2} />
      </span>
    </button>
  );
}

function Dot({ needs, flight }: { needs: boolean; flight: boolean }) {
  if (needs) return <span className="h-1.5 w-1.5 rounded-full bg-ember" />;
  if (flight) return <span className="h-1.5 w-1.5 rounded-full bg-slate" />;
  return <span className="h-1.5 w-1.5 rounded-full bg-line" />;
}
