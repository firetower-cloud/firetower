"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useGetSession } from "@/src/api/generated/sessions/sessions";
import { AgentMark } from "@/components/AgentMark";
import { FileGlyph } from "@/components/FileGlyph";
import { Signal } from "@/components/Signal";
import { leafOf } from "@/src/api/text";
import {
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
          onClose={() => close(tab.id)}
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

  // The conversation is the session, so it is named after it — and there is no
  // closing it, because closing would leave the session with nothing on screen.
  const label =
    tab.kind === "agent"
      ? (session?.name ?? "Agent")
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
        <Glyph tab={tab} status={session?.status} agent={session?.agent} />
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
  if (tab.kind === "agent") {
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
          className="fixed z-40 w-[248px] rounded-[10px] border border-line bg-panel p-1 shadow-[0_12px_36px_-14px_rgba(0,0,0,0.85)]"
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
          {/* Honest rather than hidden: a session runs one agent today, and an
              entry that quietly did nothing would be worse than one that says
              why it cannot. */}
          <Choice
            glyph="✳"
            label="New agent here"
            hint="One agent per session for now"
            disabled
          />
        </div>
      )}
    </div>
  );
}

function Choice({
  glyph,
  label,
  hint,
  onClick,
  disabled,
}: {
  glyph: string;
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
      <span className="mt-px w-3 shrink-0 text-center font-mono text-[11px] text-mute">
        {glyph}
      </span>
      <span className="min-w-0">
        <span className="block text-[12.5px] text-bone">{label}</span>
        <span className="block text-[11px] text-mute">{hint}</span>
      </span>
    </button>
  );
}
