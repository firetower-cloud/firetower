"use client";

/**
 * The workspace as a tree you unfold.
 *
 * It used to be a directory you walked: clicking a folder replaced the list
 * with its contents and the only way back was a `..` row. That is a file
 * *browser*, and nobody reading code wants one — you want `src/` open beside
 * `tests/`, and the shape of the repository in front of you while you pick.
 * So a folder folds, and nothing is ever hidden to show something else.
 *
 * Confined to the workspace: paths resolve inside it, `..` is refused by the
 * worker, and a symbolic link is shown rather than followed — a repository can
 * contain one pointing at `/`. The shell is the escape hatch for anything
 * outside.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronsDownUp, Download, RotateCw, Search, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useListFiles } from "@/src/api/generated/sessions/sessions";
import type { FileEntry } from "@/src/api/generated/model";
import { ApiError, apiBase, token } from "@/src/api/http";
import { Icon } from "@/components/ui";
import { FileGlyph } from "@/components/FileGlyph";
import { useOpen, useTabs } from "@/src/workspace/tabs";
import { useRevealed, useTree } from "@/src/workspace/tree";
import { Results } from "./Finder";

/** One level of nesting, in pixels. Deep enough to read, tight enough to fit. */
const STEP = 12;

export function Tree({ sessionId, changed }: { sessionId: string; changed: Set<string> }) {
  const [q, setQ] = useState("");
  const { expanded, toggle, collapseAll } = useTree(sessionId);
  const open = useOpen();
  const { set } = useTabs();
  const client = useQueryClient();

  // Resolved once here rather than in every row: four hundred rows each
  // subscribing to the tab context is four hundred re-renders every time
  // somebody opens a tab.
  const active = set?.active[set.focused] ?? null;
  const showing = active?.startsWith("file:") ? active.slice(5) : null;

  const {
    data: entries = [],
    isLoading,
    error,
  } = useListFiles(sessionId, { path: "" }, { query: { staleTime: 30_000 } });

  // A directory carries the mark of anything changed inside it, so a folded
  // tree still says where the work is.
  const marked = useMemo(() => {
    const dirs = new Set<string>();
    for (const path of changed) {
      const parts = path.split("/");
      let at = "";
      for (const part of parts.slice(0, -1)) {
        at = at ? `${at}/${part}` : part;
        dirs.add(at);
      }
    }
    return dirs;
  }, [changed]);

  const searching = q.trim().length > 0;

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-1.5">
        <span className="eyebrow">Files</span>
        <button
          onClick={collapseAll}
          title="Fold everything"
          aria-label="Fold everything"
          className="ml-auto rounded-sm p-1 text-mute transition-colors hover:bg-raise/60 hover:text-bone"
        >
          <Icon of={ChevronsDownUp} size={12} />
        </button>
        <button
          onClick={() =>
            client.invalidateQueries({ queryKey: [`/api/v1/sessions/${sessionId}/files`] })
          }
          title="Read the workspace again"
          aria-label="Read the workspace again"
          className="rounded-sm p-1 text-mute transition-colors hover:bg-raise/60 hover:text-bone"
        >
          <Icon of={RotateCw} size={12} />
        </button>
      </div>

      <Filter value={q} onChange={setQ} />

      {searching ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
          <Results sessionId={sessionId} q={q} onOpen={(path) => open.file(path)} />
        </div>
      ) : (
        <Body sessionId={sessionId}>
          {isLoading && <Line>Looking…</Line>}
          {error && (
            <Line>{error instanceof ApiError ? error.message : "Couldn't read that."}</Line>
          )}
          {entries.map((entry: FileEntry) => (
            <Node
              key={entry.name}
              sessionId={sessionId}
              dir=""
              entry={entry}
              depth={0}
              expanded={expanded}
              toggle={toggle}
              changed={changed}
              marked={marked}
              showing={showing}
              onOpen={open.file}
            />
          ))}
          {!isLoading && !error && entries.length === 0 && <Line>Nothing here.</Line>}
        </Body>
      )}
    </section>
  );
}

/**
 * The scrolling part, and the thing that scrolls it.
 *
 * Opening a file from the finder unfolds the tree down to it, which is no use
 * if the row lands nine hundred pixels below the fold. The rows it unfolded are
 * not on screen yet when the ask arrives — each directory is still fetching —
 * so this waits for the row to exist rather than looking once and giving up.
 */
function Body({ sessionId, children }: { sessionId: string; children: React.ReactNode }) {
  const asked = useRevealed(sessionId);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!asked) return;
    const path = asked.slice(0, asked.lastIndexOf("#"));

    let tries = 0;
    let frame = 0;
    const look = () => {
      const row = box.current?.querySelector(`[data-path="${CSS.escape(path)}"]`);
      if (row) {
        row.scrollIntoView({ block: "center" });
        return;
      }
      // About a second and a half of frames — long enough for a few nested
      // listings to arrive, short enough that a path that is not there stops
      // being waited for.
      if (tries++ < 90) frame = requestAnimationFrame(look);
    };
    look();
    return () => cancelAnimationFrame(frame);
  }, [asked]);

  return (
    <div ref={box} className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
      {children}
    </div>
  );
}

/** Find a file by name, without leaving the panel. */
function Filter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
      <Icon of={Search} size={12} className="shrink-0 text-mute" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onChange("")}
        placeholder="Find a file…"
        aria-label="Find a file"
        className="min-w-0 flex-1 bg-transparent text-ui text-text placeholder:text-mute focus:outline-none"
      />
      {value && (
        <button
          onClick={() => onChange("")}
          aria-label="Clear"
          className="shrink-0 rounded-sm p-0.5 text-mute transition-colors hover:text-bone"
        >
          <Icon of={X} size={12} />
        </button>
      )}
    </div>
  );
}

/**
 * One entry, and everything under it if it is open.
 *
 * Each open directory holds its own listing. The alternative — one recursive
 * fetch on expand — reads a `node_modules` into a hundred thousand rows to draw
 * the four somebody wanted.
 */
function Node({
  sessionId,
  dir,
  entry,
  depth,
  expanded,
  toggle,
  changed,
  marked,
  showing,
  onOpen,
}: {
  sessionId: string;
  dir: string;
  entry: FileEntry;
  depth: number;
  expanded: Set<string>;
  toggle: (path: string) => void;
  changed: Set<string>;
  marked: Set<string>;
  /** The file the middle pane is showing, if it is one. */
  showing: string | null;
  onOpen: (path: string) => void;
}) {
  const path = dir ? `${dir}/${entry.name}` : entry.name;

  // A link is described, never followed — so it is a leaf here whatever it
  // points at, and there is nothing under it we could be sure is inside the
  // workspace.
  const foldable = entry.directory && !entry.link;
  const unfolded = foldable && expanded.has(path);

  const { data: kids = [], isLoading } = useListFiles(
    sessionId,
    { path },
    { query: { enabled: unfolded, staleTime: 30_000 } },
  );

  const active = showing === path;
  const touched = entry.directory ? marked.has(path) : changed.has(path);

  return (
    <>
      <div className="group relative">
        <button
          onClick={() => (foldable ? toggle(path) : onOpen(path))}
          data-path={path}
          title={path}
          className={`flex h-6 w-full items-center rounded-sm pr-1.5 text-left transition-colors ${
            active ? "bg-raise" : "hover:bg-raise/60"
          }`}
        >
          {/* One guide per level above this one, so a row six deep still says
              which trunk it hangs off. */}
          {Array.from({ length: depth }, (_, i) => (
            <span
              key={i}
              style={{ width: STEP }}
              className="h-full shrink-0 border-l border-line-soft"
            />
          ))}

          {/* Reserved on a file too, so names line up under their siblings
              instead of stepping in and out down the list. */}
          <span
            style={{ width: STEP + 4 }}
            className="flex h-full shrink-0 items-center justify-center"
          >
            {foldable && <FileGlyph name={entry.name} directory open={unfolded} size={12} />}
          </span>

          {!foldable && (
            <FileGlyph name={entry.name} link={entry.link} size={14} className="mr-1.5" />
          )}

          <span
            className={`min-w-0 flex-1 truncate text-ui ${
              active
                ? "text-bone"
                : entry.directory
                  ? "text-bone"
                  : "text-text group-hover:text-bone"
            }`}
          >
            {entry.name}
          </span>

          {touched && (
            <span
              title="Changed"
              className="ml-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate group-hover:hidden"
            />
          )}
        </button>

        {/* Outside the row's button rather than inside it: a button in a button
            is not a thing a browser will render. */}
        {!entry.directory && !entry.link && (
          <button
            onClick={() => download(sessionId, path, entry.name)}
            title={`Download ${entry.name}`}
            aria-label={`Download ${entry.name}`}
            className="absolute top-0 right-0.5 flex h-6 items-center rounded-sm px-1 text-mute opacity-0 transition-opacity group-hover:opacity-100 hover:text-bone"
          >
            <Icon of={Download} size={12} />
          </button>
        )}
      </div>

      {unfolded && (
        <>
          {isLoading && kids.length === 0 && (
            <Line indent={depth + 1}>Looking…</Line>
          )}
          {!isLoading && kids.length === 0 && <Line indent={depth + 1}>Empty.</Line>}
          {kids.map((kid: FileEntry) => (
            <Node
              key={kid.name}
              sessionId={sessionId}
              dir={path}
              entry={kid}
              depth={depth + 1}
              expanded={expanded}
              toggle={toggle}
              changed={changed}
              marked={marked}
              showing={showing}
              onOpen={onOpen}
            />
          ))}
        </>
      )}
    </>
  );
}

function Line({ children, indent = 0 }: { children: React.ReactNode; indent?: number }) {
  return (
    <p
      style={{ paddingLeft: indent * STEP + STEP + 4 }}
      className="py-1 text-meta text-mute"
    >
      {children}
    </p>
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
