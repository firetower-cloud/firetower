/**
 * What a profile is allowed to reach — its team, or its skills.
 *
 * Empty selection means **All**: the profile sees everything the owner can,
 * which is the default and the resting state (one line, no list to scroll).
 * Narrow it and the picker opens — searchable, grouped by directory so a whole
 * client's set is one tri-state click. The stored value is just the ids ticked,
 * so nothing joins a bounded profile silently.
 */
import { useMemo, useState } from "react";
import { Check, Minus, Search } from "lucide-react";

export type ScopeItem = {
  id: string;
  name: string;
  desc?: string;
  /** The directory it's filed in, as a label — `d/client-a`, or `yours`. */
  group: string;
  badge?: { text: string; tone: "sage" | "brick" };
};

export function ScopePicker({
  label,
  hint,
  items,
  selected,
  onChange,
  searchPlaceholder,
  allNote,
}: {
  label: string;
  hint: string;
  items: ScopeItem[];
  selected: string[];
  onChange: (ids: string[]) => void;
  searchPlaceholder: string;
  allNote: string;
}) {
  const [expanded, setExpanded] = useState(selected.length > 0);
  const [q, setQ] = useState("");
  const set = useMemo(() => new Set(selected), [selected]);

  const query = q.trim().toLowerCase();
  const shown = query
    ? items.filter(
        (i) => i.name.toLowerCase().includes(query) || (i.desc ?? "").toLowerCase().includes(query),
      )
    : items;

  // Grouped by directory, directories first and "yours" last.
  const groups = useMemo(() => {
    const by = new Map<string, ScopeItem[]>();
    for (const i of shown) (by.get(i.group) ?? by.set(i.group, []).get(i.group)!).push(i);
    return [...by.entries()].sort(([a], [b]) =>
      a === "yours" ? 1 : b === "yours" ? -1 : a.localeCompare(b),
    );
  }, [shown]);

  const toggle = (id: string) => {
    const next = new Set(set);
    next.has(id) ? next.delete(id) : next.add(id);
    onChange([...next]);
  };
  const setMany = (ids: string[], on: boolean) => {
    const next = new Set(set);
    for (const id of ids) (on ? next.add(id) : next.delete(id));
    onChange([...next]);
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div className="text-ui font-medium text-bone">
          {label}
          <span className="ml-2 text-meta font-normal text-mute">
            {selected.length === 0 ? "· all" : `· ${selected.length} of ${items.length}`}
          </span>
        </div>
        <div className="flex rounded-lg border border-line bg-ground p-0.5">
          <button
            type="button"
            onClick={() => {
              setExpanded(false);
              onChange([]);
            }}
            className={`rounded-md px-3 py-1 text-meta transition-colors ${
              !expanded ? "bg-overlay text-bone" : "text-dim hover:text-bone"
            }`}
          >
            All
          </button>
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className={`rounded-md px-3 py-1 text-meta transition-colors ${
              expanded ? "bg-overlay text-bone" : "text-dim hover:text-bone"
            }`}
          >
            Only these
          </button>
        </div>
      </div>
      <p className="mt-1 text-micro text-mute">{hint}</p>

      {!expanded ? (
        <div className="mt-2 flex items-center gap-2.5 rounded-lg border border-line bg-ground px-3 py-2.5 text-meta text-dim">
          <Check className="h-4 w-4 shrink-0 text-sage" strokeWidth={2} />
          <span>{allNote}</span>
        </div>
      ) : (
        <div className="mt-2 overflow-hidden rounded-lg border border-line bg-ground">
          <div className="flex items-center gap-2.5 border-b border-line-soft px-3 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-mute" strokeWidth={1.8} />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={searchPlaceholder}
              className="w-full bg-transparent text-meta text-bone placeholder:text-mute focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-3 border-b border-line-soft px-3 py-1.5 text-micro">
            <span className="text-dim">
              <span className="text-sage">{selected.length}</span> selected
            </span>
            <span className="ml-auto flex gap-3.5">
              <button
                type="button"
                className="text-slate hover:text-bone"
                onClick={() => setMany(shown.map((i) => i.id), true)}
              >
                Select all
              </button>
              <button
                type="button"
                className="text-slate hover:text-bone"
                onClick={() => setMany(shown.map((i) => i.id), false)}
              >
                Clear
              </button>
            </span>
          </div>
          <div className="scroll-slim max-h-72 overflow-y-auto">
            {groups.length === 0 && (
              <p className="px-3 py-4 text-center text-micro text-mute">Nothing matches “{q}”.</p>
            )}
            {groups.map(([name, rows]) => {
              const ids = rows.map((r) => r.id);
              const on = ids.filter((id) => set.has(id)).length;
              const all = on === ids.length && ids.length > 0;
              const some = on > 0 && !all;
              return (
                <div key={name}>
                  <button
                    type="button"
                    onClick={() => setMany(ids, !all)}
                    className="sticky top-0 flex w-full items-center gap-2.5 border-b border-line-soft bg-panel px-3 py-1.5 text-left"
                  >
                    <span
                      className={`grid h-4 w-4 shrink-0 place-items-center rounded border ${
                        all
                          ? "border-sage bg-sage text-ground"
                          : some
                            ? "border-sage-deep bg-sage-deep text-bone"
                            : "border-mute"
                      }`}
                    >
                      {all && <Check className="h-3 w-3" strokeWidth={3.5} />}
                      {some && <Minus className="h-3 w-3" strokeWidth={3.5} />}
                    </span>
                    <span className="font-mono text-meta text-slate">{name}</span>
                    <span className="text-micro text-mute">· {on} of {ids.length}</span>
                  </button>
                  {rows.map((r) => {
                    const chosen = set.has(r.id);
                    return (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => toggle(r.id)}
                        className={`flex w-full items-center gap-2.5 border-b border-line-soft px-3 py-2 pl-7 text-left last:border-0 hover:bg-raise ${
                          chosen ? "bg-sage-tint/40" : ""
                        }`}
                      >
                        <span
                          className={`grid h-4 w-4 shrink-0 place-items-center rounded border ${
                            chosen ? "border-sage bg-sage text-ground" : "border-mute"
                          }`}
                        >
                          {chosen && <Check className="h-3 w-3" strokeWidth={3.5} />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="text-ui text-bone">{r.name}</span>
                          {r.desc && <span className="ml-2 text-meta text-mute">{r.desc}</span>}
                        </span>
                        {r.badge && (
                          <span
                            className={`shrink-0 rounded-full border px-1.5 py-0.5 text-micro ${
                              r.badge.tone === "brick"
                                ? "border-brick-deep bg-brick-tint text-brick"
                                : "border-sage-deep bg-sage-tint text-sage"
                            }`}
                          >
                            {r.badge.text}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
