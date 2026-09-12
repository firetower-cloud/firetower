/**
 * ⌘K.
 *
 * The one interaction that, more than any amount of chrome, makes an app read as
 * a tool rather than a page. It is also the first place the multi-server idea
 * has to hold up under speed: you type three letters and the thing you want is
 * on someone else's machine, and that has to be obvious without being loud.
 *
 * So every result carries its server as a mark, never as a colour — the same
 * rule as the strip and the rows.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Search } from "lucide-react";
import { BACKENDS, STATE, setReach } from "~/mock/backends";
import { useFixtures } from "~/mock/socket";
import { group, shortRepo } from "@/src/api/workspaces";
import { navigate } from "~/shims/next-navigation";

type Item = {
  id: string;
  label: string;
  hint?: string;
  mark?: string;
  kind: "session" | "command";
  run: () => void;
};

export function Palette({ open, onClose }: { open: boolean; onClose: () => void }) {
  useFixtures();
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setAt(0);
      // A frame later: the element is not focusable until it is on screen.
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    // Workspaces, not raw sessions: it is the place you want to go to, and
    // three agents in one worktree should not be three results.
    const sessions: Item[] = BACKENDS.flatMap((b) =>
      group(STATE[b.id].filter((s) => s.status !== "Ended")).groups.flatMap(([repo, places]) =>
        places.map((p) => ({
          id: `${b.id}:${p.id}`,
          label: p.name,
          hint: `${shortRepo(repo)} · ${p.branch ?? "—"}`,
          mark: b.mark,
          kind: "session" as const,
          run: () => navigate(`/sessions/${p.id}`),
        })),
      ),
    );

    const commands: Item[] = [
      { id: "c:connect", label: "Connect to a Firetower…", kind: "command", run: () => navigate("/connect") },
      { id: "c:fleet", label: "Everything, across servers", kind: "command", run: () => navigate("/fleet") },
      { id: "c:tasks", label: "Tasks", kind: "command", run: () => navigate("/tasks") },
      { id: "c:config", label: "Configuration", kind: "command", run: () => navigate("/configuration") },
      { id: "c:style", label: "Open the style guide", kind: "command", run: () => navigate("/style") },
      ...BACKENDS.map((b) => ({
        id: `c:drop:${b.id}`,
        label: `${b.reach === "unreachable" ? "Reconnect" : "Disconnect"} ${b.org}`,
        kind: "command" as const,
        run: () => setReach(b.id, b.reach === "unreachable" ? "live" : "unreachable"),
      })),
    ];

    const all = [...sessions, ...commands];
    if (!q.trim()) return all.slice(0, 9);

    // Subsequence match, the way every palette worth using does it: "vs" finds
    // "vault scoping".
    const needle = q.toLowerCase().replace(/\s+/g, "");
    const scored = all
      .map((i) => ({ i, s: score(needle, i.label.toLowerCase()) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    return scored.slice(0, 9).map((x) => x.i);
  }, [q]);

  useEffect(() => setAt(0), [q]);

  if (!open) return null;

  const choose = (i?: Item) => {
    if (!i) return;
    i.run();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ground/60 pt-[14vh] backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        className="w-[560px] overflow-hidden rounded-lg border border-line bg-overlay shadow-(--shadow-float)"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search className="h-3.5 w-3.5 shrink-0 text-mute" strokeWidth={2} />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setAt((n) => Math.min(n + 1, items.length - 1));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setAt((n) => Math.max(n - 1, 0));
              }
              if (e.key === "Enter") choose(items[at]);
            }}
            placeholder="Go to a session, or run something"
            className="h-11 flex-1 bg-transparent text-body text-bone placeholder:text-mute focus:outline-none"
          />
        </div>

        <div className="p-1.5">
          {items.length === 0 && <div className="px-2 py-3 text-ui text-mute">Nothing matches.</div>}
          {items.map((i, n) => (
            <button
              key={i.id}
              onMouseEnter={() => setAt(n)}
              onClick={() => choose(i)}
              data-on={n === at}
              className="row w-full text-left"
              style={{ gridTemplateColumns: "18px 1fr auto", height: "32px" }}
            >
              <span className="text-micro font-bold text-mute" style={{ fontFamily: "var(--font-narrow)" }}>
                {i.mark ?? "›"}
              </span>
              <span className="flex min-w-0 items-baseline gap-2">
                <span className={`truncate text-ui ${n === at ? "text-bone" : "text-text"}`}>{i.label}</span>
                {i.hint && <span className="truncate text-meta text-mute">{i.hint}</span>}
              </span>
              {n === at && <CornerDownLeft className="h-3 w-3 text-dim" strokeWidth={2} />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Subsequence, rewarding runs and word starts. Enough to feel right. */
function score(needle: string, hay: string): number {
  let s = 0;
  let at = -1;
  let run = 0;
  for (const ch of needle) {
    const found = hay.indexOf(ch, at + 1);
    if (found === -1) return 0;
    run = found === at + 1 ? run + 1 : 0;
    s += 1 + run * 2 + (found === 0 || hay[found - 1] === " " ? 3 : 0);
    at = found;
  }
  return s;
}
