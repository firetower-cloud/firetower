/**
 * ⌘P.
 *
 * Scoped to this workspace and to files only, which is what separates it from
 * ⌘K — that one crosses servers and does commands, this one answers "where is
 * that file" without making you say which of the three things you meant.
 */
import { useEffect, useMemo, useState } from "react";
import { CornerDownLeft } from "lucide-react";
import { PATHS } from "~/mock/files";
import { langOf } from "~/syntax";

const TONE: Record<string, string> = {
  rust: "text-kind-native",
  ts: "text-kind-source",
  sql: "text-kind-store",
  toml: "text-kind-data",
  make: "text-kind-style",
  text: "text-kind-prose",
};

export function QuickOpen({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (path: string) => void;
}) {
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);

  useEffect(() => {
    if (open) {
      setQ("");
      setAt(0);
    }
  }, [open]);

  const hits = useMemo(() => {
    if (!q.trim()) return PATHS.slice(0, 10);
    const needle = q.toLowerCase().replace(/\s+/g, "");
    return PATHS.map((p) => ({ p, s: score(needle, p.toLowerCase()) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 10)
      .map((x) => x.p);
  }, [q]);

  useEffect(() => setAt(0), [q]);

  if (!open) return null;

  const choose = (path?: string) => {
    if (!path) return;
    onPick(path);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ground/50 pt-[12vh] backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="w-[34rem] overflow-hidden rounded-xl border border-line bg-overlay shadow-(--shadow-float)"
      >
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setAt((n) => Math.min(n + 1, hits.length - 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setAt((n) => Math.max(n - 1, 0));
            }
            if (e.key === "Enter") choose(hits[at]);
          }}
          placeholder="Go to a file"
          className="w-full border-b border-line bg-transparent px-4 py-3.5 text-read text-bone placeholder:text-mute focus:outline-none"
        />

        <div className="p-1.5">
          {hits.length === 0 && <p className="px-2.5 py-3 text-ui text-mute">No file matches.</p>}
          {hits.map((path, n) => (
            <button
              key={path}
              onMouseEnter={() => setAt(n)}
              onClick={() => choose(path)}
              data-on={n === at}
              className="row w-full"
            >
              <span className={`shrink-0 text-micro ${TONE[langOf(path)]}`}>●</span>
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className={`truncate font-mono text-ui ${n === at ? "text-bone" : "text-text"}`}>
                  {path.split("/").pop()}
                </span>
                <span className="truncate font-mono text-micro text-mute">
                  {path.split("/").slice(0, -1).join("/")}
                </span>
              </span>
              {n === at && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-dim" strokeWidth={1.75} />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function score(needle: string, hay: string): number {
  let s = 0;
  let at = -1;
  let run = 0;
  for (const ch of needle) {
    const found = hay.indexOf(ch, at + 1);
    if (found === -1) return 0;
    run = found === at + 1 ? run + 1 : 0;
    s += 1 + run * 2 + (hay[found - 1] === "/" ? 4 : 0);
    at = found;
  }
  return s;
}
