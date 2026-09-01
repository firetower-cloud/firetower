"use client";

import { FileDiff, FolderOpen, GitBranch, PanelRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Icon } from "@/components/ui";
import { useState } from "react";
import {
  useGetSession,
  useSessionDiff,
  useSessionWork,
} from "@/src/api/generated/sessions/sessions";
import { useOpen } from "@/src/workspace/tabs";
import { usePanel, VIEWS, type View } from "@/src/workspace/panel";
import { Signal } from "@/components/Signal";
import { STATUS_LABEL } from "@/src/api/view";
import { shipping } from "@/src/api/ship";
import { useListEvents } from "@/src/api/generated/events/events";
import { stepLines, ready } from "@/components/Steps";
import { PathRow, Counts } from "./PathRow";
import { Tree } from "./Tree";
import { ShipPanel } from "./ShipPanel";
import { CloseWorkspace } from "./CloseWorkspace";

/**
 * The workspace of whatever is in front of you.
 *
 * One view at a time behind a strip of icons, rather than two sections sharing
 * the height. Files and Changes used to be stacked, which meant neither had
 * room and a third thing could never be added — and the third thing turned out
 * to be the one that mattered, because reviewing a change was a modal drawn
 * over the conversation that produced it.
 *
 * Everything here opens a tab in the middle. Nothing here is a viewer: a file
 * opens a file tab, a change opens a diff tab, at full width, beside the run.
 */
export function Inspector({ sessionId }: { sessionId: string | null }) {
  const panel = usePanel();

  // Asked once here and read by the tree and the strip's badge. React Query
  // serves the Changes view from the same cache entry, so marking modified
  // files in the tree costs no extra request.
  const { data: files = [] } = useSessionDiff(sessionId ?? "", undefined, {
    query: { enabled: !!sessionId, refetchInterval: 8_000 },
  });

  if (!panel.open) {
    // The strip survives a collapse, so there is always a way back.
    return (
      <aside className="hidden h-full w-[38px] shrink-0 flex-col items-center border-l border-line bg-panel pt-2 xl:flex">
        <Strip changed={files.length} vertical />
      </aside>
    );
  }

  return (
    <aside className="hidden h-full shrink-0 xl:flex">
      <Grip />

      <div
        style={{ width: panel.width }}
        className="flex h-full min-h-0 flex-col overflow-hidden border-l border-line bg-panel"
      >
        <Strip changed={files.length} />

        {!sessionId ? (
          <div className="px-3 py-4">
            <p className="text-meta text-dim">No session in front of you.</p>
            <p className="mt-1 text-meta leading-[1.55] text-mute">
              Open one and its files, its changes and the way out show up here.
            </p>
          </div>
        ) : (
          <>
            {panel.view === "files" && (
              <Tree sessionId={sessionId} changed={new Set(files.map((f) => f.path))} />
            )}
            {panel.view === "changes" && <Changes sessionId={sessionId} />}
            {panel.view === "ship" && <ShipPanel sessionId={sessionId} />}
            <Doing sessionId={sessionId} />
          </>
        )}
      </div>
    </aside>
  );
}

/** Which view, as icons. Pressing the one you are on collapses the panel. */
function Strip({ changed, vertical = false }: { changed: number; vertical?: boolean }) {
  const panel = usePanel();

  return (
    <div
      className={
        vertical
          ? "flex flex-col items-center gap-1"
          : "flex shrink-0 items-center gap-0.5 border-b border-line px-1.5 py-1"
      }
    >
      {VIEWS.map((v) => {
        const on = panel.open && panel.view === v.id;
        return (
          <button
            key={v.id}
            onClick={() => panel.show(v.id)}
            title={`${v.label} (⌘⌥${v.key})`}
            aria-label={v.label}
            aria-pressed={on}
            // An underline rather than a filled pill: the strip sits on the
            // same ground as the panel it labels, and a pill would read as a
            // button floating above it rather than a tab belonging to it.
            className={`relative rounded-sm px-2 py-1.5 transition-colors ${
              on ? "text-bone" : "text-mute hover:bg-raise/60 hover:text-dim"
            } ${
              on && !vertical
                ? "after:absolute after:inset-x-1.5 after:-bottom-1 after:h-[2px] after:bg-bone after:content-['']"
                : ""
            }`}
          >
            <ViewIcon view={v.id} />
            {/* Changes carries a count: the point of a strip is telling you a
                view has something in it without having to open it. */}
            {v.id === "changes" && changed > 0 && (
              <span className="absolute -top-0.5 -right-0.5 rounded-full bg-bone px-1 font-mono text-micro leading-[13px] text-ground">
                {changed > 9 ? "9+" : changed}
              </span>
            )}
          </button>
        );
      })}

      {!vertical && (
        <button
          onClick={panel.toggle}
          title="Collapse the panel"
          aria-label="Collapse the panel"
          className="ml-auto rounded-sm px-2 py-1.5 text-mute transition-colors hover:bg-raise/60 hover:text-dim"
        >
          <Icon of={PanelRight} size={14} />
        </button>
      )}
    </div>
  );
}

/** One glyph per view, from the one icon set, at the one stroke weight. */
const VIEW_ICON: Record<View, LucideIcon> = {
  files: FolderOpen,
  changes: FileDiff,
  ship: GitBranch,
};

function ViewIcon({ view }: { view: View }) {
  return <Icon of={VIEW_ICON[view]} size={14} />;
}

/**
 * The edge you drag to resize.
 *
 * 320px is tight for a commit message and generous for a file tree, and only
 * the person looking knows which of those they are doing.
 *
 * The listeners are attached in the handler rather than from an effect. An
 * effect does not run until React has committed the render that `setDragging`
 * caused, and the pointer does not wait — every move in that gap is lost, so a
 * quick drag moved the edge by nothing at all. Attaching synchronously means
 * the first move after the press is already being watched.
 */
function Grip() {
  const panel = usePanel();
  const [dragging, setDragging] = useState(false);
  // `setWidth` is stable — it reads the store rather than closing over it.
  const { setWidth } = panel;

  const begin = (e: React.PointerEvent<HTMLDivElement>) => {
    // Stops the drag from turning into a text selection across the page.
    e.preventDefault();
    setDragging(true);

    // Measured from the window's right edge rather than accumulated from a
    // delta, so a pointer that outruns the handler does not leave the panel
    // trailing behind it.
    const move = (m: PointerEvent) => setWidth(window.innerWidth - m.clientX);

    const done = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", done);
      window.removeEventListener("pointercancel", done);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setDragging(false);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", done);
    // A pointer the browser takes away — a gesture, a window switch — must end
    // the drag too, or the page is left resizing with nothing held down.
    window.addEventListener("pointercancel", done);

    // The whole window takes the resize cursor for the length of the drag:
    // without it the cursor flickers back to a caret the moment it leaves the
    // five pixels of the handle, which it does immediately.
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div
      onPointerDown={begin}
      onDoubleClick={() => setWidth(320)}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the panel"
      title="Drag to resize · double-click to reset"
      className={`w-[5px] shrink-0 cursor-col-resize transition-colors ${
        dragging ? "bg-dim" : "hover:bg-line"
      }`}
    />
  );
}

/**
 * What the session is doing, and the way out of it, pinned under every view.
 *
 * The answer to "is it still going" was at the bottom of the transcript, which
 * meant scrolling away from whatever you were reading to find it. It is one
 * line, and it belongs somewhere that does not move.
 *
 * Closing sits on that line. It used to be a word at the bottom of the Ship
 * view — so the only control that ends a workspace was filed under the one
 * thing most workspaces never do, and you had to already know it was there.
 * This row is the part of the panel that talks *about* the workspace rather
 * than showing a view of it, which makes it the honest place for the exit and
 * the reason it is under every view rather than one of them.
 *
 * A fourth glyph in the strip was the other candidate and is worse: the strip
 * is a set of views, and one of them silently being a destructive action is a
 * thing you only mispress once.
 */
function Doing({ sessionId }: { sessionId: string }) {
  const { data: session } = useGetSession(sessionId);
  // The same query the session tab runs, served from one cache entry — and kept
  // current by the socket rather than by either of them polling.
  const { data: events = [] } = useListEvents({ since: 0, sessionId });
  // No interval of its own. Ship polls this same cache entry while it is open,
  // and all this reads from it is whether the work went in — which, once it
  // has, does not go back to open. Asking the git host on every view, for every
  // workspace somebody has open, to decide how to draw one button is not worth
  // the requests.
  const { data: work } = useSessionWork(sessionId, {
    query: { enabled: !!session?.repo, staleTime: 30_000 },
  });

  if (!session) return null;

  // Whatever is running — the same lines the bring-up draws, read for the one
  // that is current rather than all of them. Nothing once the workspace is up:
  // the status says "Ready" and repeating the last completed step under it
  // said "Starting the agent" about an agent that had finished starting.
  const lines = stepLines(session, events);
  const now = ready(lines) ? undefined : lines.find((l) => l.state === "running");
  const under = now?.detail || (now ? LABEL[now.step] : undefined);

  // Merged is the one state where closing is the next thing to do rather than
  // one of the things you may do, so it takes the room to say so — in place of
  // the quiet one on the status line, never beside it.
  const finished = shipping(session, work).stage === "merged";

  return (
    <div className="shrink-0 border-t border-line px-3 py-2">
      <div className="flex items-center gap-2">
        <Signal status={session.status} size={6} />
        <span className="min-w-0 flex-1 truncate text-meta text-dim">
          {STATUS_LABEL[session.status] ?? session.status}
        </span>
        {!finished && <CloseWorkspace session={session} />}
      </div>
      {under && (
        <p className="mt-0.5 truncate pl-[14px] font-mono text-micro text-mute" title={under}>
          {under}
        </p>
      )}
      {finished && (
        <div className="mt-2">
          <CloseWorkspace session={session} prominent />
        </div>
      )}
    </div>
  );
}

/** What each bring-up step is called, for the line under the status. */
const LABEL: Record<string, string> = {
  Fetch: "Fetching the repository",
  Worktree: "Creating the worktree",
  Workspace: "Making the workspace",
  Setup: "Running setup",
  Launch: "Starting the agent",
};

/** What is in the workspace that is not safely elsewhere. */
function Changes({ sessionId }: { sessionId: string }) {
  const { data: files = [], isLoading } = useSessionDiff(sessionId, undefined, {
    query: { refetchInterval: 8_000 },
  });
  const open = useOpen();
  const panel = usePanel();

  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="eyebrow">Changes</span>
        <span className="ml-auto font-mono text-micro text-mute">
          {isLoading ? "…" : files.length === 0 ? "none" : `${files.length} files`}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
        {files.map((f) => (
          <PathRow
            key={f.path}
            path={f.path}
            onClick={() => open.diff(f.path)}
            trail={<Counts added={f.added} removed={f.removed} />}
          />
        ))}

        {!isLoading && files.length === 0 && <Line>Nothing has changed yet.</Line>}
      </div>

      {files.length > 0 && (
        <div className="shrink-0 border-t border-line px-3 py-2">
          <p className="mb-2 font-mono text-micro text-mute">
            <span className="text-sage">+{added}</span>{" "}
            <span className="text-brick">−{removed}</span>
          </p>
          <button
            onClick={() => panel.reveal("ship")}
            className="w-full rounded-md border border-line py-1.5 text-meta text-dim transition-colors hover:border-line hover:text-bone"
          >
            Review &amp; ship →
          </button>
        </div>
      )}
    </section>
  );
}

function Line({ children }: { children: React.ReactNode }) {
  return <p className="px-1.5 py-1 text-meta text-mute">{children}</p>;
}
