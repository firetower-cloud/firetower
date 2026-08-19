"use client";

import { useState } from "react";
import { useListFiles } from "@/src/api/generated/sessions/sessions";
import { apiBase, token, ApiError } from "@/src/api/http";
import type { FileEntry } from "@/src/api/generated/model";

/**
 * The workspace, as a directory you can walk.
 *
 * Confined to the workspace on purpose: paths resolve inside it, `..` is
 * refused by the worker, and a symbolic link is shown rather than followed —
 * a repository can contain one pointing at `/`. The shell tab is the escape
 * hatch for anything outside.
 */
export function Files({ sessionId }: { sessionId: string }) {
  const [path, setPath] = useState("");
  const [failed, setFailed] = useState<string | null>(null);
  const [fetching, setFetching] = useState<string | null>(null);

  const { data: entries = [], isLoading, error, refetch } = useListFiles(sessionId, { path });

  /**
   * Downloaded with `fetch` and saved as a blob rather than followed as a
   * link: the token goes in a header that way. The terminal puts one in a
   * query string only because a web socket cannot set headers, and a URL is
   * the one place a credential should not end up.
   */
  const download = async (entry: FileEntry) => {
    const full = path ? `${path}/${entry.name}` : entry.name;
    setFailed(null);
    setFetching(full);

    try {
      const url = new URL(`${apiBase()}/api/v1/sessions/${sessionId}/file`);
      url.searchParams.set("path", full);

      const auth = token();
      const answer = await fetch(url, {
        headers: auth ? { authorization: `Bearer ${auth}` } : undefined,
      });

      if (!answer.ok) {
        const body = await answer.json().catch(() => null);
        throw new Error(body?.message ?? `That didn't work (${answer.status}).`);
      }

      const blob = await answer.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = entry.name;
      a.click();
      URL.revokeObjectURL(href);
    } catch (e) {
      setFailed(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setFetching(null);
    }
  };

  const parts = path ? path.split("/") : [];

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-[6px] border border-line bg-[#0f0e0d]">
      <div className="flex items-center gap-1.5 border-b border-line px-3 py-1.5">
        <button
          onClick={() => setPath("")}
          className="font-mono text-[11.5px] text-mute transition-colors hover:text-ember"
        >
          workspace
        </button>
        {parts.map((part, i) => (
          <span key={`${part}-${i}`} className="flex items-center gap-1.5">
            <span className="text-mute/60">/</span>
            <button
              onClick={() => setPath(parts.slice(0, i + 1).join("/"))}
              className="font-mono text-[11.5px] text-dim transition-colors hover:text-ember"
            >
              {part}
            </button>
          </span>
        ))}
        <button
          onClick={() => refetch()}
          className="ml-auto text-[11px] text-mute transition-colors hover:text-ember"
        >
          ↻
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
        {isLoading && <p className="px-1.5 py-1 text-[12px] text-mute">Looking…</p>}

        {error && (
          <p className="px-1.5 py-1 text-[12px] text-bone">
            {error instanceof ApiError ? error.message : "Couldn't read that directory."}
          </p>
        )}

        {path && (
          <button
            onClick={() => setPath(parts.slice(0, -1).join("/"))}
            className="flex w-full items-center gap-2 rounded-[4px] px-1.5 py-1 text-left transition-colors hover:bg-panel"
          >
            <span className="text-mute">⟵</span>
            <span className="font-mono text-[12px] text-dim">..</span>
          </button>
        )}

        {entries.map((entry) => (
          <div
            key={entry.name}
            className="flex items-center gap-2 rounded-[4px] px-1.5 py-1 transition-colors hover:bg-panel"
          >
            <span className="text-mute">{entry.directory ? "▸" : entry.link ? "↗" : "▪"}</span>

            {entry.directory ? (
              <button
                onClick={() => setPath(path ? `${path}/${entry.name}` : entry.name)}
                className="min-w-0 flex-1 truncate text-left font-mono text-[12px] text-bone transition-colors hover:text-ember"
              >
                {entry.name}/
              </button>
            ) : (
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-text">
                {entry.name}
              </span>
            )}

            <span className="w-16 text-right font-mono text-[11px] text-mute">
              {entry.directory ? "" : size(entry.size)}
            </span>
            <span className="hidden w-24 text-right font-mono text-[11px] text-mute sm:block">
              {when(entry.modified)}
            </span>

            {/* A link is shown, never followed — so there is nothing here to
                download that we could be sure is inside the workspace. */}
            {!entry.directory && !entry.link && (
              <button
                onClick={() => download(entry)}
                disabled={fetching != null}
                className="w-5 text-[12px] text-mute transition-colors hover:text-ember disabled:opacity-40"
                title={`Download ${entry.name}`}
              >
                {fetching === (path ? `${path}/${entry.name}` : entry.name) ? "…" : "↓"}
              </button>
            )}
          </div>
        ))}

        {!isLoading && !error && entries.length === 0 && (
          <p className="px-1.5 py-1 text-[12px] text-mute">Nothing here.</p>
        )}
      </div>

      {failed && (
        <p className="border-t border-line px-3 py-2 text-[11.5px] leading-[1.5] text-bone">
          {failed}
        </p>
      )}
    </div>
  );
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

function when(iso?: string | null): string {
  if (!iso) return "";
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}
