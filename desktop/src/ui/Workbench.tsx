/**
 * A workspace: the conversation, with the repository beside it.
 *
 * The chat is the screen — it gets the middle and the reading width — and what
 * the agent has done to the repository sits in a rail you keep open or push
 * away. The earlier arrangement made both of them tabs, which meant reviewing a
 * diff hid the conversation that explained it. They are two halves of one job.
 */
import { useEffect, useState } from "react";
import { Cpu, Globe, PanelRight, Pencil, SquareTerminal, Trash2, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { getListSessionsQueryKey, useDestroySession, useRenameSession } from "@/src/api/generated/sessions/sessions";
import { isLive } from "~/mock/http";
import { Signal } from "@/components/Signal";
import { AgentMark } from "@/components/AgentMark";
import { group } from "@/src/api/workspaces";
import { talkFor, type Backend } from "~/mock/backends";
import { useSession, useSessions } from "~/data";
import { useStart } from "~/start";
import { navigate } from "~/shims/next-navigation";
import { Chat } from "~/ui/Chat";
import { FileTab } from "~/ui/FileTab";
import { PreviewTab } from "~/ui/PreviewTab";
import { PortPicker } from "~/ui/PortPicker";
import { QuickOpen } from "~/ui/QuickOpen";
import { TabStrip, type Tab } from "~/ui/Tabs";
import { Inspector } from "~/ui/Inspector";
import { TerminalPane } from "~/ui/TerminalPane";
import { Unreachable } from "~/ui/Unreachable";
import { drag } from "~/drag";

/** The rail can be dragged between these. */
const RAIL_MIN = 288;
const RAIL_DEFAULT = 368;

type Side = "diff" | "files" | "ship";

export function Workbench({ backend, workspace }: { backend: Backend; workspace: string }) {
  const { data: sessions } = useSessions();
  const opened = useSession(workspace);
  const start = useStart();
  const [side, setSide] = useState<Side>("diff");
  const [open, setOpen] = useState(true);
  const [width, setWidth] = useState(() => {
    try {
      const held = Number(localStorage.getItem("firetower.inspector.width"));
      return held >= RAIL_MIN ? held : RAIL_DEFAULT;
    } catch {
      return RAIL_DEFAULT;
    }
  });
  /* Dragging the rail's edge. Pointer capture on the handle keeps the drag
     alive when the pointer outruns it, and the width is clamped so the rail
     can neither vanish nor push the conversation off the screen. */
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    const from = { x: e.clientX, width };
    handle.setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (ev: PointerEvent) => {
      const next = Math.round(Math.min(window.innerWidth * 0.6, Math.max(RAIL_MIN, from.width + (from.x - ev.clientX))));
      setWidth(next);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setWidth((w) => {
        try {
          localStorage.setItem("firetower.inspector.width", String(w));
        } catch {
          // A browser told to keep nothing; the width lasts the session.
        }
        return w;
      });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  };
  const [term, setTerm] = useState(false);
  const [reading, setReading] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([{ id: "chat" }]);
  const [active, setActive] = useState("chat");
  const [finding, setFinding] = useState(false);

  /**
   * Open a file, the way an editor does.
   *
   * A single click *previews*: the tab opens in italic and the next preview
   * replaces it, so skimming six files while reading a diff leaves one tab
   * rather than six. Double-clicking the tab keeps it.
   */
  const openFile = (path: string, keep = false) => {
    setTabs((held) => {
      const already = held.find((t) => "path" in t && t.path === path);
      if (already) {
        return keep ? held.map((t) => (t.id === already.id ? { ...t, preview: false } : t)) : held;
      }
      const tab: Tab = { id: `f:${path}`, path, preview: !keep };
      const slot = held.findIndex((t) => "preview" in t && t.preview);
      if (!keep && slot !== -1) {
        const next = [...held];
        next[slot] = tab;
        return next;
      }
      return [...held, tab];
    });
    setActive(`f:${path}`);
  };

  /* A preview is a kept tab from the start: nobody skims ports. */
  const [picking, setPicking] = useState(false);
  const openPreview = (port: number) => {
    const id = `p:${port}`;
    setTabs((held) => (held.some((t) => t.id === id) ? held : [...held, { id, port }]));
    setActive(id);
    setPicking(false);
  };

  const closeTab = (id: string) => {
    setTabs((held) => {
      const at = held.findIndex((t) => t.id === id);
      const next = held.filter((t) => t.id !== id);
      if (active === id) setActive((next[at] ?? next[at - 1] ?? next[0]).id);
      return next;
    });
  };

  /* The workspace is the group of sessions sharing this id; the one opened by
     id is the header's truth even before the list has caught up — the moment
     after "Start it" the list may not hold it yet, but `get_session` does. */
  const running = sessions.filter((s) => s.status !== "Ended");
  const found = group(running).groups.flatMap(([, ps]) => ps).find((p) => p.id === workspace);
  const place =
    found ??
    (opened.data
      ? { id: workspace, name: opened.data.name, branch: opened.data.branch ?? undefined, runs: [opened.data] }
      : undefined);

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
      // The editor gesture for "go to a file", on the key editors use for it.
      if (e.key.toLowerCase() === "p") {
        e.preventDefault();
        setFinding(true);
      }
      if (e.key.toLowerCase() === "w") {
        e.preventDefault();
        if (active !== "chat") closeTab(active);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const cache = useQueryClient();
  const rename = useRenameSession();
  const destroy = useDestroySession();
  const [renaming, setRenaming] = useState<string | null>(null);

  if (!place) {
    return (
      <div className="grid flex-1 place-items-center text-ui text-mute">
        {opened.loading ? "Opening…" : (opened.error ?? "That workspace isn’t here.")}
      </div>
    );
  }

  /* A workspace is a checkout with several agents in it, so the conversation
     is one agent's. Default to the one that wants you, then to the first that
     is not a shell — a `cargo watch` running beside the work is not what you
     opened this to read. */
  const primary =
    place.runs.find((r) => r.status === "NeedsYou" || r.status === "HandedBack") ??
    place.runs.find((r) => r.agent !== "Shell") ??
    place.runs[0];
  /* Opened by a session id, that session is what you came to read — before any
     guess about which agent "matters". The guess is only for a workspace id. */
  const run =
    place.runs.find((r) => r.id === reading) ??
    place.runs.find((r) => r.id === workspace) ??
    primary;

  const talk = talkFor(place.id);
  const live = isLive();

  if (backend.reach === "unreachable") return <Unreachable org={backend.org} />;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-ground">
      {/* A toolbar, not a tab bar: what this workspace is, who is in it, and
          the two things you toggle. */}
      <div {...drag} className="flex h-11 shrink-0 items-center gap-3 border-b border-line px-3">
        {renaming !== null ? (
          <input
            autoFocus
            value={renaming}
            onChange={(e) => setRenaming(e.target.value)}
            onBlur={() => setRenaming(null)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setRenaming(null);
              if (e.key === "Enter" && renaming.trim() && live) {
                rename.mutate({ id: run.id, data: { name: renaming.trim() } }, { onSuccess: () => cache.invalidateQueries({ queryKey: getListSessionsQueryKey() }) });
                setRenaming(null);
              }
            }}
            className="w-56 rounded-md border border-line bg-ground px-2 py-1 text-ui text-bone focus:outline-none"
          />
        ) : (
          <button onDoubleClick={() => setRenaming(place.name)} title="Double-click to rename" className="flex min-w-0 items-center gap-1.5 truncate text-ui text-bone">
            {place.name}
            <Pencil className="h-3 w-3 shrink-0 text-mute opacity-0 transition-opacity hover:opacity-100" strokeWidth={1.75} />
          </button>
        )}
        {run.usage && (
          <span className="flex shrink-0 items-center gap-1.5 text-micro text-mute" title="What this workspace is using on its machine">
            <Cpu className="h-3 w-3" strokeWidth={1.75} />
            {Math.round(run.usage.cpu * 10) / 10} cores · {Math.round(run.usage.memoryMb)} MB
          </span>
        )}

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
          <button
            onClick={() => start({ workspaceId: place.id, title: place.name, repo: run.repo ?? undefined })}
            title="Another agent in this workspace"
            className="grid h-7 w-7 place-items-center rounded-md text-mute transition-colors hover:bg-raise hover:text-bone"
          >
            +
          </button>
        </span>

        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setTerm(!term)}
            title="Terminal  ⌘J"
            className={`control ${term ? "bg-overlay text-bone" : "text-mute hover:bg-raise hover:text-bone"}`}
          >
            <SquareTerminal className="h-4 w-4" strokeWidth={1.75} />
          </button>
          {live && (
            <button
              onClick={() => {
                if (!window.confirm(`End "${place.name}"? Its branch stays on the machine; the agents stop.`)) return;
                destroy.mutate({ id: run.id, params: undefined as never }, { onSuccess: () => { cache.invalidateQueries({ queryKey: getListSessionsQueryKey() }); navigate("/"); } });
              }}
              title="End this session"
              className="control text-mute hover:bg-raise hover:text-brick"
            >
              <Trash2 className="h-4 w-4" strokeWidth={1.75} />
            </button>
          )}
          <div className="relative">
            <button
              onClick={() => setPicking((p) => !p)}
              title="Preview a port"
              className={`control ${picking ? "bg-overlay text-bone" : "text-mute hover:bg-raise hover:text-bone"}`}
            >
              <Globe className="h-4 w-4" strokeWidth={1.75} />
            </button>
            {picking && <PortPicker sessionId={run.id} open={tabs.flatMap((t) => ("port" in t ? [t.port] : []))} onPick={openPreview} onClose={() => setPicking(false)} />}
          </div>
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
        {/* `min-h-0` on both columns: a flex child defaults to
            `min-height: auto` and refuses to shrink below its content, so without
            it this grows past the window and the pane below never scrolls. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {tabs.length > 1 && (
            <TabStrip
              tabs={tabs}
              active={active}
              onPick={setActive}
              onClose={closeTab}
              onKeep={(id) =>
                setTabs((held) => held.map((t) => (t.id === id ? { ...t, preview: false } : t)))
              }
            />
          )}

          <div className="min-h-0 flex-1">
            {active === "chat" ? (
              <Chat
                session={run}
                branch={place.branch}
                onOpenFile={openFile}
                onOpenDiff={() => {
                  setSide("diff");
                  setOpen(true);
                }}
              />
            ) : "port" in (tabs.find((t) => t.id === active) ?? {}) ? (
              <PreviewTab session={run} port={(tabs.find((t) => t.id === active) as { port: number }).port} />
            ) : (
              <FileTab session={run} path={(tabs.find((t) => t.id === active) as { path: string }).path} />
            )}
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
              <div className="h-[calc(100%-2rem)]">
                <TerminalPane place={place} />
              </div>
            </div>
          )}
        </div>

        {open && (
          <div onPointerDown={startResize} title="Drag to resize" className="group/handle relative z-10 -mr-px w-1 shrink-0 cursor-col-resize">
            <div className="absolute inset-y-0 left-0 w-px bg-transparent transition-colors duration-150 group-hover/handle:bg-slate group-active/handle:bg-slate" />
          </div>
        )}
        {open && (
          <Inspector
            width={width}
            session={run}
            workspace={place.id}
            branch={place.branch}
            fixtureDiffs={talk.diffs}
            tab={side}
            onTab={setSide}
            onOpenFile={openFile}
            onClose={() => setOpen(false)}
          />
        )}
      </div>

      <QuickOpen sessionId={run.id} open={finding} onClose={() => setFinding(false)} onPick={(p) => openFile(p, true)} />
    </div>
  );
}
