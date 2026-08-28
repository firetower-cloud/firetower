"use client";

import { useState } from "react";
import { useListFiles, useSessionDiff } from "@/src/api/generated/sessions/sessions";
import { ApiError, apiBase, token } from "@/src/api/http";
import type { FileEntry } from "@/src/api/generated/model";
import { useOpen } from "@/src/workspace/tabs";

/**
 * The workspace of whatever is in front of you.
 *
 * Files above, changes below, both at once rather than behind tabs: the two
 * questions — what is in here, and what has it touched — get asked together,
 * and a modified file you can see in the tree while its entry sits in Changes
 * is the whole reason to put them on the same edge.
 *
 * Everything here opens a tab in the middle. Nothing here is a viewer.
 */
export function Inspector({ sessionId }: { sessionId: string | null }) {
  if (!sessionId) {
    return (
      <Panel>
        <p className="px-3 py-4 text-[12.5px] text-mute">
          Open a session and its workspace shows up here.
        </p>
      </Panel>
    );
  }

  return (
    <Panel>
      <Tree sessionId={sessionId} />
      <Changes sessionId={sessionId} />
    </Panel>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <aside className="hidden h-full w-[320px] shrink-0 flex-col overflow-hidden border-l border-line bg-panel xl:flex">
      {children}
    </aside>
  );
}

/**
 * The workspace as a directory you can walk.
 *
 * Confined to the workspace: paths resolve inside it, `..` is refused by the
 * worker, and a symbolic link is shown rather than followed. The shell is the
 * escape hatch for anything outside.
 */
function Tree({ sessionId }: { sessionId: string }) {
  const [path, setPath] = useState("");
  const { data: entries = [], isLoading, error, refetch } = useListFiles(sessionId, { path });
  const open = useOpen();

  const parts = path ? path.split("/") : [];
  const full = (name: string) => (path ? `${path}/${name}` : name);

  return (
    <section className="flex min-h-0 flex-[3] flex-col overflow-hidden">
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
        {error && (
          <Line>{error instanceof ApiError ? error.message : "Couldn't read that."}</Line>
        )}

        {path && (
          <button
            onClick={() => setPath(parts.slice(0, -1).join("/"))}
            className="flex w-full items-center gap-2 rounded-[4px] px-1.5 py-1 text-left transition-colors hover:bg-raise/60"
          >
            <span className="text-mute">⟵</span>
            <span className="font-mono text-[11.5px] text-dim">..</span>
          </button>
        )}

        {entries.map((entry: FileEntry) => (
          <div
            key={entry.name}
            className="group flex items-center gap-2 rounded-[4px] px-1.5 py-1 transition-colors hover:bg-raise/60"
          >
            <span className="shrink-0 text-[10px] text-mute">
              {entry.directory ? "▸" : entry.link ? "↗" : "▪"}
            </span>
            <button
              onClick={() =>
                entry.directory ? setPath(full(entry.name)) : open.file(sessionId, full(entry.name))
              }
              title={full(entry.name)}
              className={`min-w-0 flex-1 truncate text-left font-mono text-[11.5px] transition-colors hover:text-ember ${
                entry.directory ? "text-bone" : "text-dim"
              }`}
            >
              {entry.name}
              {entry.directory ? "/" : ""}
            </button>

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

/**
 * What is in the workspace that is not safely elsewhere.
 *
 * Under the tree rather than beside it: this is the shorter list and the one
 * that changes, so it gets the bottom of the panel where a growing list does
 * not push anything around.
 */
function Changes({ sessionId }: { sessionId: string }) {
  const { data: files = [], isLoading } = useSessionDiff(sessionId, undefined, {
    query: { refetchInterval: 8_000 },
  });
  const open = useOpen();

  return (
    <section className="flex min-h-0 flex-[2] flex-col overflow-hidden border-t border-line">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="eyebrow">Changes</span>
        <span className="ml-auto font-mono text-[10.5px] text-mute">
          {isLoading ? "…" : files.length === 0 ? "none" : `${files.length} files`}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
        {files.map((f) => (
          <button
            key={f.path}
            onClick={() => open.diff(sessionId, f.path)}
            title={f.path}
            className="flex w-full items-baseline gap-2 rounded-[4px] px-1.5 py-1 text-left transition-colors hover:bg-raise/60"
          >
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-dim">
              {f.path.split("/").slice(-2).join("/")}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-sage">+{f.added}</span>
            <span className="shrink-0 font-mono text-[10px] text-brick">−{f.removed}</span>
          </button>
        ))}

        {!isLoading && files.length === 0 && <Line>Nothing has changed yet.</Line>}
      </div>
    </section>
  );
}

function Line({ children }: { children: React.ReactNode }) {
  return <p className="px-1.5 py-1 text-[11.5px] text-mute">{children}</p>;
}
