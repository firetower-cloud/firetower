"use client";

import { useState } from "react";
import {
  useGetSession,
  useListFiles,
  useSessionDiff,
} from "@/src/api/generated/sessions/sessions";
import { ApiError, apiBase, token } from "@/src/api/http";
import type { FileEntry } from "@/src/api/generated/model";
import { useOpen } from "@/src/workspace/tabs";
import { usePanel, VIEWS, type View } from "@/src/workspace/panel";
import { FileGlyph } from "@/components/FileGlyph";
import { Signal } from "@/components/Signal";
import { STATUS_LABEL, unfinished } from "@/src/api/view";
import { useListEvents } from "@/src/api/generated/events/events";
import { stepLines } from "@/components/Steps";
import { PathRow, Counts } from "./PathRow";
import { ShipPanel } from "./ShipPanel";

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
            <p className="text-[12.5px] text-dim">No session in front of you.</p>
            <p className="mt-1 text-[11.5px] leading-[1.55] text-mute">
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
            className={`relative rounded-[6px] px-2 py-1.5 transition-colors ${
              on ? "text-bone" : "text-mute hover:bg-raise/60 hover:text-dim"
            } ${
              on && !vertical
                ? "after:absolute after:inset-x-1.5 after:-bottom-1 after:h-[2px] after:bg-ember after:content-['']"
                : ""
            }`}
          >
            <ViewIcon view={v.id} />
            {/* Changes carries a count: the point of a strip is telling you a
                view has something in it without having to open it. */}
            {v.id === "changes" && changed > 0 && (
              <span className="absolute -top-0.5 -right-0.5 rounded-full bg-ember px-1 font-mono text-[8.5px] leading-[13px] text-ground">
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
          className="ml-auto rounded-[6px] px-2 py-1.5 text-mute transition-colors hover:bg-raise/60 hover:text-dim"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" aria-hidden>
            <rect x="1.8" y="2.4" width="10.4" height="9.2" rx="1.4" strokeWidth="1.2" />
            <path d="M9 2.4v9.2" strokeWidth="1.2" />
          </svg>
        </button>
      )}
    </div>
  );
}

function ViewIcon({ view }: { view: View }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 14 14",
    fill: "none",
    stroke: "currentColor",
    "aria-hidden": true,
  } as const;

  if (view === "files") {
    return (
      <svg {...common}>
        <path
          d="M2.4 3.2a1 1 0 011-1h2.3l1 1.4h3.9a1 1 0 011 1v6.2a1 1 0 01-1 1H3.4a1 1 0 01-1-1z"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (view === "changes") {
    // A plus over a minus. A bare `+` reads as "add something", which is the
    // one thing this view does not do.
    return (
      <svg {...common}>
        <path
          d="M4.6 4.4h4.8M7 2v4.8M4.6 9.9h4.8"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  // A branch: two commits and the line that joins them.
  return (
    <svg {...common}>
      <circle cx="4.2" cy="3.6" r="1.5" strokeWidth="1.2" />
      <circle cx="4.2" cy="10.4" r="1.5" strokeWidth="1.2" />
      <circle cx="10" cy="5.4" r="1.5" strokeWidth="1.2" />
      <path d="M4.2 5.1v3.8M10 6.9c0 1.6-1.3 2.2-2.9 2.4" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
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
        dragging ? "bg-ember" : "hover:bg-ember/40"
      }`}
    />
  );
}

/**
 * What the session is doing, pinned under every view.
 *
 * The answer to "is it still going" was at the bottom of the transcript, which
 * meant scrolling away from whatever you were reading to find it. It is one
 * line, and it belongs somewhere that does not move.
 */
function Doing({ sessionId }: { sessionId: string }) {
  const { data: session } = useGetSession(sessionId, {
    query: {
      refetchInterval: (query) => (query.state.data && unfinished(query.state.data) ? 3_000 : false),
    },
  });
  const busy = !!session && unfinished(session);
  // The same query the session tab runs, served from one cache entry.
  const { data: events = [] } = useListEvents(
    { since: 0, sessionId },
    { query: { enabled: busy, refetchInterval: busy ? 3_000 : false } },
  );

  if (!session) return null;

  // Whatever is running, or the last thing that finished — the same lines the
  // bring-up draws, read for the one that is current rather than all of them.
  const lines = stepLines(session, events);
  const now =
    lines.find((l) => l.state === "running") ??
    lines.filter((l) => l.state !== "pending").at(-1);
  const under = now?.detail || (now ? LABEL[now.step] : undefined);

  return (
    <div className="shrink-0 border-t border-line px-3 py-2">
      <div className="flex items-center gap-2">
        <Signal status={session.status} size={6} />
        <span className="truncate text-[11.5px] text-dim">
          {STATUS_LABEL[session.status] ?? session.status}
        </span>
      </div>
      {under && (
        <p className="mt-0.5 truncate pl-[14px] font-mono text-[10.5px] text-mute" title={under}>
          {under}
        </p>
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

/**
 * The workspace as a directory you can walk.
 *
 * Confined to the workspace: paths resolve inside it, `..` is refused by the
 * worker, and a symbolic link is shown rather than followed. The shell is the
 * escape hatch for anything outside.
 */
function Tree({ sessionId, changed }: { sessionId: string; changed: Set<string> }) {
  const [path, setPath] = useState("");
  const { data: entries = [], isLoading, error, refetch } = useListFiles(sessionId, { path });
  const open = useOpen();

  const parts = path ? path.split("/") : [];
  const full = (name: string) => (path ? `${path}/${name}` : name);

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-3 py-1.5">
        <span className="eyebrow">Files</span>
        <span className="ml-auto flex min-w-0 items-center gap-1 overflow-hidden">
          <button
            onClick={() => setPath("")}
            className="shrink-0 font-mono text-[10.5px] text-mute transition-colors hover:text-ember"
          >
            /
          </button>
          {parts.slice(-2).map((part, i, shown) => (
            <span key={`${part}-${i}`} className="flex min-w-0 items-center gap-1">
              <button
                onClick={() =>
                  setPath(parts.slice(0, parts.length - shown.length + i + 1).join("/"))
                }
                className="min-w-0 truncate font-mono text-[10.5px] text-dim transition-colors hover:text-ember"
              >
                {part}
              </button>
              {i < shown.length - 1 && <span className="text-mute/60">/</span>}
            </span>
          ))}
        </span>
        <button
          onClick={() => refetch()}
          className="shrink-0 text-[10px] text-mute transition-colors hover:text-ember"
        >
          ↻
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
        {isLoading && <Line>Looking…</Line>}
        {error && <Line>{error instanceof ApiError ? error.message : "Couldn't read that."}</Line>}

        {path && (
          <button
            onClick={() => setPath(parts.slice(0, -1).join("/"))}
            className="flex w-full items-center gap-2 rounded-[5px] px-1.5 py-1 text-left transition-colors hover:bg-raise/60"
          >
            <span className="text-mute">⟵</span>
            <span className="font-mono text-[11.5px] text-dim">..</span>
          </button>
        )}

        {entries.map((entry: FileEntry) => (
          <div
            key={entry.name}
            className="group flex items-center gap-2 rounded-[5px] px-1.5 py-1 transition-colors hover:bg-raise/60"
          >
            <span className="shrink-0 text-mute">
              <FileGlyph name={entry.name} directory={entry.directory} link={entry.link} />
            </span>
            <button
              onClick={() =>
                entry.directory ? setPath(full(entry.name)) : open.file(full(entry.name))
              }
              title={full(entry.name)}
              className={`min-w-0 flex-1 truncate text-left font-mono text-[11.5px] transition-colors hover:text-ember ${
                entry.directory ? "text-bone" : "text-dim"
              }`}
            >
              {entry.name}
              {entry.directory ? "/" : ""}
            </button>

            {/* The tree and Changes are the same fact asked twice. Marking it
                here means finding a modified file does not cost a trip to the
                other list and back. */}
            {changed.has(full(entry.name)) && (
              <span
                title="Changed"
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-ember group-hover:hidden"
              />
            )}

            {/* A link is shown, never followed — so there is nothing here we
                could be sure is inside the workspace. */}
            {!entry.directory && !entry.link && (
              <button
                onClick={() => download(sessionId, full(entry.name), entry.name)}
                title={`Download ${entry.name}`}
                className="shrink-0 px-0.5 text-[11px] text-mute opacity-0 transition-opacity group-hover:opacity-100 hover:text-ember"
              >
                ↓
              </button>
            )}
          </div>
        ))}

        {!isLoading && !error && entries.length === 0 && <Line>Nothing here.</Line>}
      </div>
    </section>
  );
}

/**
 * Saved through `fetch` rather than followed as a link, so the token travels in
 * a header. The terminal puts one in a query string only because a web socket
 * cannot set headers, and a URL is the one place a credential should not end up.
 */
async function download(sessionId: string, path: string, name: string) {
  const url = new URL(`${apiBase()}/api/v1/sessions/${sessionId}/file`);
  url.searchParams.set("path", path);

  const auth = token();
  const answer = await fetch(url, {
    headers: auth ? { authorization: `Bearer ${auth}` } : undefined,
  });
  if (!answer.ok) return;

  const href = URL.createObjectURL(await answer.blob());
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.click();
  URL.revokeObjectURL(href);
}

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
        <span className="ml-auto font-mono text-[10.5px] text-mute">
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
          <p className="mb-2 font-mono text-[10.5px] text-mute">
            <span className="text-sage">+{added}</span>{" "}
            <span className="text-brick">−{removed}</span>
          </p>
          <button
            onClick={() => panel.reveal("ship")}
            className="w-full rounded-[7px] border border-line py-1.5 text-[12px] text-dim transition-colors hover:border-ember/40 hover:text-ember"
          >
            Review &amp; ship →
          </button>
        </div>
      )}
    </section>
  );
}

function Line({ children }: { children: React.ReactNode }) {
  return <p className="px-1.5 py-1 text-[11.5px] text-mute">{children}</p>;
}
