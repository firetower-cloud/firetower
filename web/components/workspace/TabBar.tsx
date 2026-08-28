"use client";

import { useListSessions } from "@/src/api/generated/sessions/sessions";
import { Signal } from "@/components/Signal";
import { leafOf } from "@/src/api/text";
import { paneTabs, useTabs, type PaneIndex, type Tab } from "@/src/workspace/tabs";

/**
 * One strip per pane, one tab per open thing.
 *
 * A tab is a session, a file, or a diff — the same strip for all three, because
 * a person moving between "what is the agent doing" and "what did it write to
 * this file" is doing one activity, not switching modes.
 *
 * Dragging a tab onto the other half of the window splits, which is how the
 * plan-beside-the-conversation layout is reached without a menu.
 */
export function TabBar({ pane }: { pane: PaneIndex }) {
  const { state, focus, close, move, focusPane, unsplit } = useTabs();
  const tabs = paneTabs(state, pane);
  const active = state.active[pane];

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
        state.split && state.focused !== pane ? "opacity-70" : ""
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

      {tabs.length === 0 && (
        <span className="flex items-center px-3 text-[11.5px] text-mute">Nothing open</span>
      )}

      {state.split && (
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
  const { data: sessions = [] } = useListSessions();
  const session = sessions.find((s) => s.id === tab.sessionId);

  const label =
    tab.kind === "session" ? (session?.name ?? "Session") : leafOf(tab.path);

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(MIME, tab.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onMouseDown={(e) => {
        // Middle click closes, as it does everywhere else that has tabs.
        if (e.button === 1) {
          e.preventDefault();
          onClose();
        }
      }}
      className={`group flex shrink-0 cursor-default items-center gap-2 border-r border-line px-3 transition-colors ${
        on ? "bg-ground text-bone" : "text-mute hover:bg-raise/60 hover:text-dim"
      }`}
    >
      <button onClick={onPick} className="flex items-center gap-2 py-1.5">
        {tab.kind === "session" && session ? (
          <Signal status={session.status} size={6} />
        ) : (
          <span className="text-[10px] opacity-70">{tab.kind === "diff" ? "±" : "▤"}</span>
        )}
        <span className={`max-w-[22ch] truncate text-[12.5px] ${on ? "" : "font-normal"}`}>
          {label}
        </span>
      </button>
      <button
        onClick={onClose}
        aria-label={`Close ${label}`}
        className="-mr-1 shrink-0 rounded-[4px] px-1 text-[13px] leading-none text-mute opacity-0 transition-opacity group-hover:opacity-100 hover:text-brick"
      >
        ×
      </button>
    </div>
  );
}
