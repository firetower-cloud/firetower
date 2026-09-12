/**
 * A workspace: the conversation, with the repository beside it.
 *
 * The chat is the screen — it gets the middle and the reading width — and what
 * the agent has done to the repository sits in a rail you keep open or push
 * away. The earlier arrangement made both of them tabs, which meant reviewing a
 * diff hid the conversation that explained it. They are two halves of one job.
 */
import { useEffect, useState } from "react";
import { PanelRight, SquareTerminal, X } from "lucide-react";
import { Signal } from "@/components/Signal";
import { AgentMark } from "@/components/AgentMark";
import { group } from "@/src/api/workspaces";
import { STATE, talkFor, type Backend } from "~/mock/backends";
import { useFixtures } from "~/mock/socket";
import { Chat } from "~/ui/Chat";
import { Inspector } from "~/ui/Inspector";
import { TerminalPane } from "~/ui/TerminalPane";
import { Unreachable } from "~/ui/Unreachable";

type Side = "diff" | "files" | "ship";

export function Workbench({ backend, workspace }: { backend: Backend; workspace: string }) {
  useFixtures();
  const [side, setSide] = useState<Side>("diff");
  const [open, setOpen] = useState(true);
  const [term, setTerm] = useState(false);
  const [reading, setReading] = useState<string | null>(null);

  const live = STATE[backend.id].filter((s) => s.status !== "Ended");
  const place = group(live).groups.flatMap(([, ps]) => ps).find((p) => p.id === workspace);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "\\") {
        e.preventDefault();
        setOpen((o) => !o);
      }
      const to: Record<string, Side> = { "1": "diff", "2": "files", "3": "ship" };
      if (to[e.key]) {
        e.preventDefault();
        setSide(to[e.key]);
        setOpen(true);
      }
      if (e.key.toLowerCase() === "j") {
        e.preventDefault();
        setTerm((t) => !t);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!place) {
    return <div className="grid flex-1 place-items-center text-ui text-mute">That workspace isn’t here.</div>;
  }

  /* A workspace is a checkout with several agents in it, so the conversation
     is one agent's. Default to the one that wants you, then to the first that
     is not a shell — a `cargo watch` running beside the work is not what you
     opened this to read. */
  const primary =
    place.runs.find((r) => r.status === "NeedsYou" || r.status === "HandedBack") ??
    place.runs.find((r) => r.agent !== "Shell") ??
    place.runs[0];
  const run = place.runs.find((r) => r.id === reading) ?? primary;

  const talk = talkFor(place.id);

  if (backend.reach === "unreachable") return <Unreachable org={backend.org} />;

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-ground">
      {/* A toolbar, not a tab bar: what this workspace is, who is in it, and
          the two things you toggle. */}
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line px-3">
        <span className="min-w-0 truncate text-ui text-bone">{place.name}</span>

        {/* Which agent you are reading. A count would not do: two of one and
            one of another is a different place from three of one. */}
        <span className="flex shrink-0 items-center gap-1">
          {place.runs.map((r) => (
            <button
              key={r.id}
              onClick={() => setReading(r.id)}
              title={`${r.agent === "ClaudeCode" ? "Claude Code" : r.agent} — ${r.title}`}
              className={`flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors ${
                r.id === run.id
                  ? "bg-overlay text-bone shadow-(--shadow-raise)"
                  : "text-mute hover:bg-raise"
              }`}
            >
              <AgentMark agent={r.agent} size={12} />
              <Signal status={r.status} size={4} />
            </button>
          ))}
        </span>

        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setTerm(!term)}
            title="Terminal  ⌘J"
            className={`control ${term ? "bg-overlay text-bone" : "text-mute hover:bg-raise hover:text-bone"}`}
          >
            <SquareTerminal className="h-4 w-4" strokeWidth={1.75} />
          </button>
          <button
            onClick={() => setOpen(!open)}
            title="Inspector  ⌘\"
            className={`control ${open ? "bg-overlay text-bone" : "text-mute hover:bg-raise hover:text-bone"}`}
          >
            <PanelRight className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <Chat
              place={place}
              run={run}
              talk={talk}
              onOpenDiff={() => {
                setSide("diff");
                setOpen(true);
              }}
            />
          </div>

          {term && (
            <div className="h-64 shrink-0 border-t border-line">
              <div className="flex h-8 items-center gap-2 border-b border-line bg-panel px-3">
                <span className="text-meta text-dim">Terminal</span>
                <span className="font-mono text-micro text-mute">{place.branch}</span>
                <button
                  onClick={() => setTerm(false)}
                  className="ml-auto grid h-6 w-6 place-items-center rounded text-mute hover:bg-raise hover:text-bone"
                >
                  <X className="h-3.5 w-3.5" strokeWidth={2} />
                </button>
              </div>
              <div className="h-[calc(100%-2rem)] overflow-auto">
                <TerminalPane place={place} />
              </div>
            </div>
          )}
        </div>

        {open && (
          <Inspector
            workspace={place.id}
            branch={place.branch}
            diffs={talk.diffs}
            tab={side}
            onTab={setSide}
            onClose={() => setOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
