"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetSession,
  useCreateSession,
  useDestroySession,
  getListSessionsQueryKey,
} from "@/src/api/generated/sessions/sessions";
import { useListAgents } from "@/src/api/generated/agents/agents";
import { useListHosts } from "@/src/api/generated/hosts/hosts";
import type { AgentView } from "@/src/api/generated/model";
import { AgentMark, AGENT_SHORT } from "@/components/AgentMark";
import { FileGlyph } from "@/components/FileGlyph";
import { Signal } from "@/components/Signal";
import { leafOf } from "@/src/api/text";
import {
  addressOf,
  paneTabs,
  useCurrentSession,
  useOpen,
  useTabs,
  type PaneIndex,
  type Tab,
} from "@/src/workspace/tabs";

/**
 * One strip per half, holding what is open **in this session**.
 *
 * A tab is the conversation, a terminal, a file or a diff — the same strip for
 * all four, because moving between "what is the agent doing" and "what did it
 * write to this file" is one activity inside one worktree.
 *
 * Dragging a tab onto the other half splits, which is how the plan-beside-the-
 * conversation layout is reached without a menu.
 */
export function TabBar({ pane }: { pane: PaneIndex }) {
  const { set, focus, close, move, focusPane, unsplit } = useTabs();
  const tabs = paneTabs(set, pane);
  const active = set?.active[pane] ?? null;

  const cache = useQueryClient();
  const end = useDestroySession();

  // Closing an agent's tab ends the agent.
  //
  // The first shape kept the two apart — the `×` left the tab, and ending was
  // a separate menu item — on the theory that leaving a conversation should
  // not kill the process behind it. In use that is wrong: nothing else says a
  // closed tab is still running, so every close leaked an agent, a tmux
  // session and a checkout, and a morning's work left ninety processes on the
  // machine with no interface that admitted they were there.
  //
  // A terminal, a file and a diff are still just views, and closing those
  // closes nothing else.
  const shut = (tab: Tab) => {
    close(tab.id);
    if (tab.kind !== "run") return;
    end.mutate(
      { id: tab.sessionId },
      {
        onSettled: () =>
          cache.invalidateQueries({ queryKey: getListSessionsQueryKey() }),
      },
    );
  };

  return (
    <div
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }
      }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(MIME);
        if (!id) return;
        e.preventDefault();
        move(id, pane);
      }}
      onMouseDown={() => focusPane(pane)}
      className={`flex h-9 shrink-0 items-stretch gap-px overflow-x-auto border-b border-line bg-panel ${
        set?.split && set.focused !== pane ? "opacity-70" : ""
      }`}
    >
      {tabs.map((tab) => (
        <TabButton
          key={tab.id}
          tab={tab}
          on={tab.id === active}
          onPick={() => focus(tab.id)}
          onClose={() => shut(tab)}
        />
      ))}

      {/* Only the half you opened things in offers to open more; a second `+`
          in the other half would be a second way to do the same thing. */}
      {pane === 0 && <NewTab />}

      {set?.split && (
        <button
          onClick={unsplit}
          title="Close this split"
          className="ml-auto shrink-0 px-2.5 text-[12px] text-mute transition-colors hover:text-ember"
        >
          ⊟
        </button>
      )}
    </div>
  );
}

/** Carries a tab id, so a drop knows what was dragged without a global. */
const MIME = "application/x-firetower-tab";

function TabButton({
  tab,
  on,
  onPick,
  onClose,
}: {
  tab: Tab;
  on: boolean;
  onPick: () => void;
  onClose: () => void;
}) {
  const sessionId = useCurrentSession();
  const { data: session } = useGetSession(sessionId ?? "", {
    query: { enabled: !!sessionId && tab.kind === "agent" },
  });
  // A second agent is its own session, so its tab reads its own status and
  // its own kind rather than the workspace's first.
  const { data: run } = useGetSession(tab.kind === "run" ? tab.sessionId : "", {
    query: { enabled: tab.kind === "run" },
  });

  // The conversation is the session, so it is named after it — and there is no
  // closing it, because closing would leave the session with nothing on screen.
  const label =
    tab.kind === "agent"
      ? (session?.name ?? "Agent")
      : tab.kind === "run"
        ? (run?.agent ? AGENT_SHORT[run.agent] : "Agent")
        : tab.kind === "terminal"
          ? tab.n === 1
            ? "Terminal"
            : `Terminal ${tab.n}`
          : leafOf(tab.path);

  const closable = tab.kind !== "agent";

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(MIME, tab.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onMouseDown={(e) => {
        // Middle click closes, as it does everywhere else that has tabs.
        if (e.button === 1 && closable) {
          e.preventDefault();
          onClose();
        }
      }}
      // Two pixels of ember along the top edge of the active tab. The
      // background alone told you which tab was in front only by being slightly
      // less dark than its neighbours, which is not a signal at all on a screen
      // somebody has turned down.
      className={`group relative flex shrink-0 cursor-default items-center gap-2 border-r border-line px-3 transition-colors ${
        on
          ? "bg-ground text-bone before:absolute before:inset-x-0 before:top-0 before:h-[2px] before:bg-ember before:content-['']"
          : "text-mute hover:bg-raise/60 hover:text-dim"
      }`}
    >
      <button onClick={onPick} className="flex items-center gap-2 py-1.5">
        <Glyph
          tab={tab}
          status={tab.kind === "run" ? run?.status : session?.status}
          agent={tab.kind === "run" ? run?.agent : session?.agent}
        />
        <span className={`max-w-[22ch] truncate text-[12.5px] ${on ? "" : "font-normal"}`}>
          {label}
        </span>
      </button>

      {closable && (
        <button
          onClick={onClose}
          aria-label={`Close ${label}`}
          className="-mr-1 shrink-0 rounded-[4px] px-1 text-[13px] leading-none text-mute opacity-0 transition-opacity group-hover:opacity-100 hover:text-brick"
        >
          ×
        </button>
      )}
    </div>
  );
}

function Glyph({
  tab,
  status,
  agent,
}: {
  tab: Tab;
  status?: React.ComponentProps<typeof Signal>["status"];
  agent?: React.ComponentProps<typeof AgentMark>["agent"];
}) {
  if (tab.kind === "agent" || tab.kind === "run") {
    return (
      <span className="flex items-center gap-1.5">
        <Signal status={status ?? "Starting"} size={6} />
        {agent && <AgentMark agent={agent} size={12} className="opacity-80" />}
      </span>
    );
  }
  if (tab.kind === "terminal") {
    return <span className="font-mono text-[11px] opacity-70">▸</span>;
  }
  if (tab.kind === "diff") {
    return <span className="font-mono text-[11px] opacity-70">±</span>;
  }
  return <FileGlyph name={tab.path} size={12} className="opacity-70" />;
}

/** What else you can open in here. */
function NewTab() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  /** Where the menu goes, measured from the button when it opens. */
  const [at, setAt] = useState({ top: 0, left: 0 });
  const opener = useOpen();
  const { open: openTab } = useTabs();
  const cache = useQueryClient();

  // Owned here rather than in the menu below it. React Query drops a
  // component's mutation callbacks when it unmounts, and closing the menu
  // unmounts it — so the run was created and its tab never opened, which
  // looked like a cap on how many agents a workspace would take. A late one
  // that *did* fire re-opened a tab somebody had since closed.
  //
  // This button is part of the strip and never goes away, so its callback
  // always runs.
  // Not gated on `isPending`, and not opened from the mutation's own callback.
  //
  // Each agent is an independent run and several may be starting at once, so
  // disabling the list while one was in flight left later clicks landing on a
  // dead button. And one observer's `onSuccess` fires for the newest call —
  // start three quickly and the first two never opened a tab, though all three
  // runs were created. Both looked like a cap on how many a workspace takes.
  //
  // Awaiting the call answers per click, whatever else is in flight.
  const start = useCreateSession();

  const begin = async (workspaceId: string, agent: AgentView["kind"]) => {
    const made = await start.mutateAsync({ data: { workspaceId, agent } });
    cache.invalidateQueries({ queryKey: getListSessionsQueryKey() });
    openTab({ id: addressOf.run(made.id), kind: "run", sessionId: made.id });
  };

  // Before paint, so it never shows for a frame in the wrong place.
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const mark = trigger.current.getBoundingClientRect();
    setAt({ top: mark.bottom + 4, left: Math.min(mark.left, window.innerWidth - 256) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  return (
    <div ref={box} className="relative flex shrink-0 items-stretch">
      <button
        ref={trigger}
        onClick={() => setOpen(!open)}
        aria-label="Open something in this session"
        title="Open something in this session"
        className="px-3 text-[14px] leading-none text-mute transition-colors hover:bg-raise/60 hover:text-dim"
      >
        +
      </button>

      {open && (
        // `fixed`, not `absolute`: the strip scrolls sideways, and a menu
        // positioned inside it is clipped away by that scroller.
        <div
          style={{ top: at.top, left: at.left }}
          className="fixed z-40 w-[264px] rounded-[10px] border border-line bg-panel p-1 shadow-[0_12px_36px_-14px_rgba(0,0,0,0.85)]"
        >
          <Choice
            glyph="▸"
            label="New terminal"
            hint="A shell in this workspace"
            onClick={() => {
              setOpen(false);
              opener.terminal();
            }}
          />
          <Choice
            glyph="▤"
            label="Open a file"
            hint="From the Files panel on the right"
            disabled
          />

          <Agents
            onStart={(workspaceId, agent) => {
              setOpen(false);
              // Fire and forget: a failure surfaces as the run never appearing,
              // and the control plane has already said why in its own error.
              void begin(workspaceId, agent);
            }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Starting another agent in this workspace.
 *
 * Every agent the fleet knows about, gated on the machine *this workspace* is
 * on — a workspace is one directory on one host, so an agent anywhere else
 * could not see it, and there is no choosing.
 *
 * Unavailable ones stay listed and say why. Vanishing from a menu looks like
 * the thing does not exist and leaves nowhere to learn what is missing, which
 * is the same rule the create dialog follows.
 */
function Agents({
  onStart,
}: {
  onStart: (workspaceId: string, agent: AgentView["kind"]) => void;
}) {
  // The session you are in *is* the workspace: a workspace takes the id of the
  // session it was split from, and that is what the tab set is keyed by. So the
  // id is known without waiting for anything — which matters, because this
  // renders the moment the menu opens and the session may not be cached yet.
  //
  // Depending on that query meant the whole section returned `null` while it
  // loaded, so the menu opened with the agents simply absent and clicking where
  // they should have been did nothing at all.
  const workspaceId = useCurrentSession() ?? undefined;
  const { data: session } = useGetSession(workspaceId ?? "", {
    query: { enabled: !!workspaceId },
  });
  const {
    data: agents = [],
    isPending,
    isError,
    refetch,
  } = useListAgents();
  const { data: hosts = [] } = useListHosts();

  // Only needed to say *why* one is unavailable. Absent while it loads, which
  // reads as "we cannot tell yet" rather than hiding the row.
  const host = hosts.find((h) => h.id === session?.hostId);

  if (!workspaceId) return null;

  return (
    <>
      <div className="my-1 border-t border-line" />
      <p className="px-2 pt-1 pb-1.5 font-narrow text-[10px] font-semibold tracking-[0.14em] text-mute uppercase">
        Start an agent
      </p>

      {/* Three different things, which this used to say with one sentence.
          "No agents configured" is a claim about your setup, and printing it
          while the request is still in flight sent people to the Agents screen
          to add an agent they had already added. */}
      {isPending && (
        <p className="px-2 pb-1.5 text-[11.5px] text-mute" aria-busy>
          Looking…
        </p>
      )}

      {isError && (
        <button
          onClick={() => refetch()}
          className="block w-full px-2 pb-1.5 text-left text-[11.5px] text-ember hover:underline"
        >
          Couldn&rsquo;t reach the API. Retry
        </button>
      )}

      {!isPending && !isError && agents.length === 0 && (
        <p className="px-2 pb-1.5 text-[11.5px] text-mute">
          No agents configured. Add one on the Agents screen.
        </p>
      )}

      {agents.map((a) => {
        const why = session ? unavailable(a, host?.id, host?.name) : undefined;
        return (
          <Choice
            key={a.kind}
            glyph=""
            mark={a.kind}
            label={a.label}
            hint={why ?? "In this workspace, on its branch"}
            disabled={!!why}
            onClick={() => onStart(workspaceId, a.kind)}
          />
        );
      })}
    </>
  );
}

/**
 * Why this agent cannot be started here, or nothing.
 *
 * The same two questions the create dialog asks, in the same order: is it on
 * the machine at all, and can it authenticate there. A subscription lives in
 * the agent's own config on the host it was signed in on, so one machine being
 * signed in says nothing about another.
 */
function unavailable(agent: AgentView, hostId?: string, hostName?: string): string | undefined {
  if (!agent.supported) return "Firetower has no driver for it yet";
  if (!hostId) return "this workspace's host is gone";

  const here = agent.hosts.find((h) => h.hostId === hostId);
  if (!here?.installed) return `not installed on ${hostName ?? "that machine"}`;
  if (!agent.needsCredential) return undefined;
  if (here.loggedIn === true || agent.credentialSet) return undefined;
  return "no credentials for it there";
}

function Choice({
  glyph,
  mark,
  label,
  hint,
  onClick,
  disabled,
}: {
  glyph: string;
  /** An agent's own mark, where the row is about one. */
  mark?: React.ComponentProps<typeof AgentMark>["agent"];
  label: string;
  hint: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-start gap-2.5 rounded-[7px] px-2 py-1.5 text-left transition-colors enabled:hover:bg-raise disabled:opacity-40"
    >
      <span className="mt-px flex w-3 shrink-0 justify-center text-center font-mono text-[11px] text-mute">
        {mark ? <AgentMark agent={mark} size={12} /> : glyph}
      </span>
      <span className="min-w-0">
        <span className="block text-[12.5px] text-bone">{label}</span>
        <span className="block text-[11px] text-mute">{hint}</span>
      </span>
    </button>
  );
}
