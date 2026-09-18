/**
 * A workspace: the conversation, with the repository beside it.
 *
 * The chat is the screen — it gets the middle and the reading width — and what
 * the agent has done to the repository sits in a rail you keep open or push
 * away. The earlier arrangement made both of them tabs, which meant reviewing a
 * diff hid the conversation that explained it. They are two halves of one job.
 */
import { useEffect, useRef, useState } from "react";
import { Globe, PanelRight, Pencil, SquareTerminal, Trash2, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { getListSessionsQueryKey, useRenameSession } from "~/api/generated/sessions/sessions";
import { Signal } from "~/components/Signal";
import { AgentMark } from "~/components/AgentMark";
import { group } from "~/api/workspaces";
import type { Backend } from "~/fleet";
import { useSession, useSessions } from "~/data";
import { navigate } from "~/shims/next-navigation";
import { Chat } from "~/ui/Chat";
import { FileTab } from "~/ui/FileTab";
import { ImageTab } from "~/ui/ImageTab";
import { isImage } from "~/api/text";
import { PreviewTab } from "~/ui/PreviewTab";
import { PortPicker } from "~/ui/PortPicker";
import { AddAgent } from "~/ui/AddAgent";
import { QuickOpen } from "~/ui/QuickOpen";
import { TabStrip, type Tab } from "~/ui/Tabs";
import { Inspector } from "~/ui/Inspector";
import { Shell } from "~/ui/Shell";
import { StatusBar } from "~/ui/StatusBar";
import { Unreachable } from "~/ui/Unreachable";
import { ContextMenu, useMenu, type MenuItem } from "~/ui/ContextMenu";
import { useEndAgent, useEndWorkspace } from "~/ui/end";
import { useConfirm } from "~/ui/Confirm";
import { drag } from "~/drag";
import { key } from "~/platform";

/** The rail can be dragged between these. */
const RAIL_MIN = 288;
const RAIL_DEFAULT = 368;
/** And the shell panel, top to bottom. */
const TERM_MIN = 120;
const TERM_DEFAULT = 256;

type Side = "diff" | "files" | "ship";

export function Workbench({ backend, workspace }: { backend: Backend; workspace: string }) {
  const { data: sessions } = useSessions();
  const opened = useSession(workspace);
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
  /* The shell panel: `shown` is what you see, `opened` is whether a shell is
     attached at all. The worker ends a shell when its viewer detaches, so
     hiding the panel must keep the terminal mounted — only closing lets go. */
  const [term, setTerm] = useState(false);
  const [shell, setShell] = useState(false);
  const [termHeight, setTermHeight] = useState(() => {
    try {
      const held = Number(localStorage.getItem("firetower.terminal.height"));
      return held >= TERM_MIN ? held : TERM_DEFAULT;
    } catch {
      return TERM_DEFAULT;
    }
  });
  const startTermResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    const from = { y: e.clientY, height: termHeight };
    handle.setPointerCapture(e.pointerId);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    const move = (ev: PointerEvent) => setTermHeight(Math.round(Math.min(window.innerHeight * 0.7, Math.max(TERM_MIN, from.height + (from.y - ev.clientY)))));
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setTermHeight((h) => {
        try {
          localStorage.setItem("firetower.terminal.height", String(h));
        } catch {
          // Kept for the session only.
        }
        return h;
      });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  };
  const [reading, setReading] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([{ id: "chat" }]);
  const [active, setActive] = useState("chat");
  const activeRef = useRef(active);
  activeRef.current = active;
  const [finding, setFinding] = useState(false);

  /**
   * Open a file, the way an editor does.
   *
   * A single click *previews*: the tab opens in italic and the next preview
   * replaces it, so skimming six files while reading a diff leaves one tab
   * rather than six. Double-clicking the tab keeps it.
   */
  const openFile = (path: string, keep = false, line?: number) => {
    setTabs((held) => {
      const already = held.find((t) => "path" in t && !("port" in t) && t.path === path);
      if (already) {
        return held.map((t) => (t.id === already.id ? { ...t, preview: keep ? false : (t as { preview?: boolean }).preview, line } : t));
      }
      const tab: Tab = { id: `f:${path}`, path, preview: !keep, line };
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

  /* Another agent in this same workspace. */
  const [adding, setAdding] = useState(false);

  /* A preview is a kept tab from the start: nobody skims ports. */
  const [picking, setPicking] = useState(false);
  const openPreview = (port: number) => {
    const id = `p:${port}`;
    setTabs((held) => (held.some((t) => t.id === id) ? held : [...held, { id, port }]));
    setActive(id);
    setPicking(false);
  };

  /* Everything but the conversation, in one gesture. */
  const closeTabs = (ids: string[]) => {
    if (ids.length === 0) return;
    setTabs((held) => {
      const next = held.filter((t) => t.id === "chat" || !ids.includes(t.id));
      if (ids.includes(activeRef.current)) setActive(next.find((t) => t.id === activeRef.current)?.id ?? "chat");
      return next;
    });
  };
  const tabItems = (id: string): MenuItem[] => {
    const at = tabs.findIndex((t) => t.id === id);
    const others = tabs.filter((t) => t.id !== "chat" && t.id !== id).map((t) => t.id);
    const right = tabs.slice(at + 1).filter((t) => t.id !== "chat").map((t) => t.id);
    const left = tabs.slice(1, at).filter((t) => t.id !== "chat").map((t) => t.id);
    const all = tabs.filter((t) => t.id !== "chat").map((t) => t.id);
    return [
      { label: "Close", shortcut: key("W"), disabled: id === "chat", onPick: () => closeTab(id) },
      { label: "Close others", disabled: others.length === 0, onPick: () => closeTabs(others) },
      { label: "Close to the right", disabled: right.length === 0, onPick: () => closeTabs(right) },
      { label: "Close to the left", disabled: left.length === 0, onPick: () => closeTabs(left) },
      "-",
      { label: "Close all", disabled: all.length === 0, onPick: () => closeTabs(all) },
    ];
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
  /* By the workspace's id, or by any run in it: a second agent is opened by
     its own id and belongs to the place its sibling made. */
  const found = group(running)
    .groups.flatMap(([, ps]) => ps)
    .find((p) => p.id === workspace || p.runs.some((r) => r.id === workspace));
  const place =
    found ??
    (opened.data
      ? { id: workspace, name: opened.data.name, branch: opened.data.branch ?? undefined, runs: [opened.data] }
      : undefined);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      /* A focused terminal owns the keyboard. `⌘J` is the one gesture that
         is about the panel rather than what is in it. */
      const inTerminal = !!(document.activeElement as HTMLElement | null)?.closest(".xterm");
      if (inTerminal && e.key.toLowerCase() !== "j") return;
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
        setShell(true);
        setTerm((t) => !t);
      }
      // The editor gesture for "go to a file", on the key editors use for it.
      if (e.key.toLowerCase() === "p") {
        e.preventDefault();
        setFinding(true);
      }
      if (e.key.toLowerCase() === "w") {
        e.preventDefault();
        if (activeRef.current !== "chat") closeTab(activeRef.current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const cache = useQueryClient();
  const rename = useRenameSession();
  const endWorkspace = useEndWorkspace();
  const confirm = useConfirm();
  const endAgent = useEndAgent();
  const tabMenu = useMenu<string>();
  const chipMenu = useMenu<string>();
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
              if (e.key === "Enter" && renaming.trim()) {
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

        {/* Which agent you are reading. A count would not do: two of one and
            one of another is a different place from three of one. */}
        <span className="flex shrink-0 items-center gap-1">
          {place.runs.map((r) => (
            <button
              key={r.id}
              onClick={() => setReading(r.id)}
              onContextMenu={(e) => chipMenu.show(e, r.id)}
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
            onClick={() => setAdding(true)}
            title="Add an agent to this workspace"
            className="grid h-7 w-7 place-items-center rounded-md text-mute transition-colors hover:bg-raise hover:text-bone"
          >
            +
          </button>
        </span>

        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => {
              setShell(true);
              setTerm(!term);
            }}
            title={`Terminal  ${key("J")}`}
            className={`control ${term ? "bg-overlay text-bone" : "text-mute hover:bg-raise hover:text-bone"}`}
          >
            <SquareTerminal className="h-4 w-4" strokeWidth={1.75} />
          </button>
          {(
            <button
              onClick={() => void endWorkspace(place).then(({ ended, trouble }) => (ended ? navigate("/") : trouble && void confirm({ title: "It did not end.", body: trouble, action: "OK" })))}
              title="End workspace — every agent in it stops"
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
            title={`Inspector  ${key("\\")}`}
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
              onMenu={tabMenu.show}
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
            ) : "port" in (tabs.find((t) => t.id === active) ?? {}) ? null : isImage((tabs.find((t) => t.id === active) as { path: string }).path) ? (
              <ImageTab session={run} path={(tabs.find((t) => t.id === active) as { path: string }).path} />
            ) : (
              <FileTab session={run} path={(tabs.find((t) => t.id === active) as { path: string }).path} line={(tabs.find((t) => t.id === active) as { line?: number }).line} />
            )}
            {/* Previews stay mounted while another tab is up: a frame that is
                unmounted is a page reloaded, and the scroll and state you left
                it with are gone. Hidden, it keeps everything. */}
            {tabs.map((t) =>
              "port" in t ? (
                <div key={t.id} hidden={active !== t.id} className="h-full">
                  <PreviewTab
                    session={run}
                    port={t.port}
                    path={t.path}
                    onPath={(path) => setTabs((held) => held.map((x) => (x.id === t.id ? { ...x, path } : x)))}
                  />
                </div>
              ) : null,
            )}
          </div>

          {shell && (
            <div hidden={!term} style={{ height: termHeight }} className="relative flex shrink-0 flex-col border-t border-line">
              <div onPointerDown={startTermResize} title="Drag to resize" className="group/vhandle absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize">
                <div className="absolute inset-x-0 top-1 h-px bg-transparent transition-colors duration-150 group-hover/vhandle:bg-slate group-active/vhandle:bg-slate" />
              </div>
              <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
                <span className="text-meta text-dim">Shell</span>
                <span className="font-mono text-micro text-mute">{place.branch}</span>
                <span className="ml-auto text-micro text-mute">{key("J")} hides</span>
                <button
                  onClick={() => {
                    setShell(false);
                    setTerm(false);
                  }}
                  title="Close — this ends the shell and whatever it is running"
                  className="grid h-6 w-6 place-items-center rounded text-mute hover:bg-raise hover:text-bone"
                >
                  <X className="h-3.5 w-3.5" strokeWidth={2} />
                </button>
              </div>
              <div className="min-h-0 flex-1">
                <Shell sessionId={run.id} ended={run.status === "Ended"} showing={term} onOpenPath={(p, line) => openFile(p, true, line)} />
              </div>
            </div>
          )}

          <StatusBar
            session={run}
            branch={place.branch}
            onCommit={() => {
              setSide("ship");
              setOpen(true);
            }}
          />
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
            tab={side}
            onTab={setSide}
            onOpenFile={openFile}
            onClose={() => setOpen(false)}
          />
        )}
      </div>

      {tabMenu.open && <ContextMenu at={tabMenu.open.at} items={tabItems(tabMenu.open.on)} onClose={tabMenu.close} />}
      {chipMenu.open && (
        <ContextMenu
          at={chipMenu.open.at}
          onClose={chipMenu.close}
          items={[
            { label: "Read this conversation", onPick: () => setReading(chipMenu.open!.on) },
            "-",
            {
              label: place.runs.length > 1 ? "End this agent" : "End workspace",
              tone: "danger",
              onPick: () => {
                const id = chipMenu.open!.on;
                const r = place.runs.find((x) => x.id === id);
                if (place.runs.length > 1 && r) {
                  void endAgent(id, `${r.agent === "ClaudeCode" ? "Claude Code" : r.agent} — ${r.title}`, place.runs.length - 1).then((ended) => ended && id === run.id && setReading(place.runs.find((x) => x.id !== id)?.id ?? null));
                } else void endWorkspace(place).then(({ ended }) => ended && navigate("/"));
              },
            },
          ]}
        />
      )}
      {adding && <AddAgent session={run} workspaceId={place.id} onClose={() => setAdding(false)} />}
      <QuickOpen sessionId={run.id} open={finding} onClose={() => setFinding(false)} onPick={(p) => openFile(p, true)} />
    </div>
  );
}
