/**
 * One workspace: tabs across the top, a pane under them.
 *
 * The same shape as the web workbench — a tab is the conversation, a diff, a
 * terminal or a file, and the strip is the same strip whichever it is — at the
 * density a window allows, and with the chrome patterns a Mac app is expected
 * to have: a 28px tab, a status strip on the floor, ⌘1–4 to switch.
 */
import { useEffect, useState } from "react";
import { FileDiff, MessageSquare, SquareTerminal, GitBranch, Ship, CircleSlash2 } from "lucide-react";
import { Signal } from "@/components/Signal";
import { AgentMark } from "@/components/AgentMark";
import { Icon } from "@/components/ui";
import { elapsed, minutesSince, needsYou } from "@/src/api/view";
import { group } from "@/src/api/workspaces";
import { STATE, talkFor, type Backend } from "~/mock/backends";
import { useFixtures } from "~/mock/socket";
import { Conversation } from "~/ui/Conversation";
import { DiffPane } from "~/ui/DiffPane";
import { TerminalPane } from "~/ui/TerminalPane";

const TABS = [
  { id: "chat", label: "Conversation", icon: MessageSquare, key: "1" },
  { id: "diff", label: "Diff", icon: FileDiff, key: "2" },
  { id: "term", label: "Terminal", icon: SquareTerminal, key: "3" },
  { id: "ship", label: "Ship", icon: Ship, key: "4" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function Workbench({ backend, workspace }: { backend: Backend; workspace: string }) {
  useFixtures();
  const [tab, setTab] = useState<TabId>("chat");

  const live = STATE[backend.id].filter((s) => s.status !== "Ended");
  const place = group(live).groups.flatMap(([, ps]) => ps).find((p) => p.id === workspace);

  /* ⌘1–4. The shortcut a tabbed desktop app is expected to have, and the
     clearest single signal that this is not a web page in a window. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const hit = TABS.find((t) => t.key === e.key);
      if (hit) {
        e.preventDefault();
        setTab(hit.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!place) {
    return (
      <div className="grid flex-1 place-items-center text-ui text-mute">
        That workspace isn’t here.
      </div>
    );
  }

  const talk = talkFor(place.id);
  const dark = backend.reach === "unreachable";
  const lead = place.runs[0];

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-ground">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line bg-panel px-2">
        {TABS.map((t) => {
          const count = t.id === "diff" ? talk.diffs.length : 0;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-ui transition-colors duration-150 ${
                tab === t.id ? "bg-overlay text-bone" : "text-mute hover:bg-raise hover:text-dim"
              }`}
            >
              <Icon of={t.icon} size={12} />
              {t.label}
              {count > 0 && <span className="font-mono text-micro text-mute">{count}</span>}
              {t.id === "chat" && place.runs.some(needsYou) && (
                <span className="h-1.5 w-1.5 rounded-full bg-ember" />
              )}
            </button>
          );
        })}

        <span className="ml-auto flex items-center gap-1.5 pr-1">
          {place.runs.map((run) => (
            <span key={run.id} className="flex items-center gap-1 rounded-sm bg-raise px-1.5 py-0.5">
              <AgentMark agent={run.agent} size={10} className="text-mute" />
              <Signal status={run.status} size={4} />
            </span>
          ))}
        </span>
      </div>

      {dark ? (
        <Unreachable org={backend.org} />
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden">
          {tab === "chat" && <Conversation place={place} talk={talk} />}
          {tab === "diff" && <DiffPane diffs={talk.diffs} />}
          {tab === "term" && <TerminalPane place={place} />}
          {tab === "ship" && <ShipPane place={place} diffs={talk.diffs} />}
        </div>
      )}

      <footer className="flex h-[22px] shrink-0 items-center gap-3 border-t border-line bg-panel px-3 text-meta text-mute">
        <span className="flex items-center gap-1">
          <span className="server-mark grid h-3.5 w-3.5 place-items-center text-[8px]">{backend.mark}</span>
          {backend.org}
        </span>
        <span className="flex items-center gap-1 font-mono">
          <Icon of={GitBranch} size={12} />
          {place.branch}
        </span>
        <span className="font-mono">{lead.repo}</span>
        <span className="ml-auto tabular-nums">{elapsed(minutesSince(lead.createdAt))}</span>
      </footer>
    </div>
  );
}

function ShipPane({ place, diffs }: { place: { name: string; branch?: string }; diffs: { added: number; removed: number }[] }) {
  const added = diffs.reduce((n, d) => n + d.added, 0);
  const removed = diffs.reduce((n, d) => n + d.removed, 0);

  return (
    <div className="mx-auto max-w-[620px] px-6 py-6">
      <span className="eyebrow">Ship</span>
      <h1 className="mt-1 text-display text-bone">{place.name}</h1>
      <p className="mt-1 font-mono text-meta text-mute">
        {place.branch} → main · <span className="text-sage">+{added}</span>{" "}
        <span className="text-brick">−{removed}</span> across {diffs.length} files
      </p>

      <label className="mt-5 block">
        <span className="eyebrow">Title</span>
        <input
          defaultValue="Add the device flow to auth"
          className="mt-1 w-full rounded-md border border-line bg-panel px-3 py-2 text-ui text-bone focus:border-slate-deep focus:outline-none"
        />
      </label>

      <label className="mt-3 block">
        <span className="eyebrow">Description</span>
        <textarea
          rows={5}
          defaultValue={"Serves the device flow we already consume, so a native client can\nauthenticate without a password form.\n\nCodes are single use and expire in ten minutes."}
          className="mt-1 w-full resize-none rounded-md border border-line bg-panel px-3 py-2 text-body text-text focus:border-slate-deep focus:outline-none"
        />
      </label>

      <div className="mt-4 flex gap-2">
        <button className="rounded-md border border-sage-deep bg-sage-tint px-3 py-1.5 text-ui font-medium text-sage transition-colors hover:bg-sage-deep/40">
          Open a pull request
        </button>
        <button className="rounded-md border border-line bg-raise px-3 py-1.5 text-ui text-text transition-colors hover:bg-overlay">
          Push only
        </button>
      </div>
    </div>
  );
}

/**
 * The state the memo expects to be common. Deliberate, not broken: the work is
 * still running on their machines — it is this client that has no route.
 */
function Unreachable({ org }: { org: string }) {
  return (
    <div className="grid flex-1 place-items-center">
      <div className="max-w-[340px] text-center">
        <Icon of={CircleSlash2} size={20} className="mx-auto text-mute" />
        <h2 className="mt-3 text-title text-bone">Can’t reach {org}</h2>
        <p className="mt-1.5 text-body text-dim">
          Everything here is still running on their machines. This client has no route to the
          control plane.
        </p>
        <button className="mt-4 rounded-md border border-line bg-raise px-3 py-1.5 text-ui text-text transition-colors hover:bg-overlay">
          Check Tailscale
        </button>
      </div>
    </div>
  );
}
