"use client";

/**
 * Finding a file by name.
 *
 * Two ways in, one list. The rail carries a filter above the tree, for when you
 * are already looking at the workspace; `⌘P` opens the same list over the
 * middle pane, for when you are not — and that one is muscle memory from every
 * editor anybody arrives here from.
 *
 * The matching happens on the machine that holds the workspace. The alternative
 * is sending the whole path index to the browser and filtering it here, which
 * would be instant to type against and would push a monorepo's worth of paths
 * down a pipe shared with every terminal on that host.
 */

import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useFindFiles } from "@/src/api/generated/sessions/sessions";
import { Icon } from "@/components/ui";
import { FileGlyph } from "@/components/FileGlyph";
import { useCurrentSession, useOpen } from "@/src/workspace/tabs";
import { reveal } from "@/src/workspace/tree";

/** Long enough that a fast typist sends one search, not eight. */
const SETTLE = 120;

export function useFind(sessionId: string, q: string) {
  const query = useDebounced(q.trim(), SETTLE);

  const { data: paths = [], isFetching } = useFindFiles(
    sessionId,
    { q: query, limit: 200 },
    { query: { enabled: query.length > 0, staleTime: 10_000 } },
  );

  // While the debounce is still settling the answer on screen belongs to the
  // previous query. Saying "nothing found" about a query nobody has run yet is
  // the one wrong thing a search can say.
  return { paths, waiting: isFetching || query !== q.trim(), query };
}

/** The results, for the filter row in the rail. */
export function Results({
  sessionId,
  q,
  onOpen,
}: {
  sessionId: string;
  q: string;
  onOpen: (path: string) => void;
}) {
  const { paths, waiting } = useFind(sessionId, q);

  if (paths.length === 0) {
    return (
      <p className="px-1.5 py-1 text-meta text-mute">{waiting ? "Looking…" : "No file by that name."}</p>
    );
  }

  return (
    <>
      {paths.map((path) => (
        <Hit
          key={path}
          path={path}
          onClick={() => {
            reveal(sessionId, path);
            onOpen(path);
          }}
        />
      ))}
    </>
  );
}

/**
 * The same list, over the middle pane, on `⌘P`.
 *
 * It listens for the key itself rather than going through `useWorkbenchKeys`,
 * which ignores anything typed while a field has focus — and the whole point of
 * this one is that it opens while you are writing a message.
 *
 * `⌘P` is a browser shortcut, and the rule in `keys.ts` is to leave those
 * alone. This is the exception the rule allows for: nobody prints a workbench,
 * and every editor this replaces has trained the same two keys.
 */
export function Finder() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const sessionId = useCurrentSession();
  const openTab = useOpen();
  const field = useRef<HTMLInputElement>(null);

  const { paths, waiting } = useFind(sessionId ?? "", sessionId ? q : "");

  useEffect(() => {
    const pressed = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setQ("");
        setAt(0);
        setOpen(true);
      }
    };
    window.addEventListener("keydown", pressed);
    return () => window.removeEventListener("keydown", pressed);
  }, []);

  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);

  if (!open || !sessionId) return null;

  // Clamped rather than reset from an effect: a shorter list arriving under a
  // cursor sitting on row nine is a render, not an event to react to.
  const cursor = Math.min(at, Math.max(paths.length - 1, 0));

  const take = (path: string, beside: boolean) => {
    reveal(sessionId, path);
    openTab.file(path, beside);
    setOpen(false);
  };

  const typed = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return setOpen(false);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      return setAt(paths.length ? (cursor + 1) % paths.length : 0);
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      return setAt(paths.length ? (cursor - 1 + paths.length) % paths.length : 0);
    }
    if (e.key === "Enter" && paths[cursor]) {
      e.preventDefault();
      take(paths[cursor], e.shiftKey);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh]">
      <div className="fixed inset-0 bg-ground/70 backdrop-blur-[3px]" onClick={() => setOpen(false)} />

      <div className="relative w-full max-w-[560px] overflow-hidden rounded-lg border border-line bg-panel shadow-float">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
          <Icon of={Search} size={14} className="shrink-0 text-mute" />
          <input
            ref={field}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setAt(0);
            }}
            onKeyDown={typed}
            placeholder="Find a file…"
            aria-label="Find a file"
            className="min-w-0 flex-1 bg-transparent text-ui text-bone placeholder:text-mute focus:outline-none"
          />
          <span className="shrink-0 font-mono text-micro text-mute">
            {q.trim() && !waiting ? `${paths.length}` : ""}
          </span>
        </div>

        <div className="max-h-[46vh] overflow-y-auto p-1.5">
          {!q.trim() && <p className="px-1.5 py-1 text-meta text-mute">Type part of a name.</p>}
          {q.trim() && paths.length === 0 && (
            <p className="px-1.5 py-1 text-meta text-mute">
              {waiting ? "Looking…" : "No file by that name."}
            </p>
          )}
          {paths.map((path, i) => (
            <Hit
              key={path}
              path={path}
              on={i === cursor}
              onHover={() => setAt(i)}
              onClick={() => take(path, false)}
            />
          ))}
        </div>

        <div className="flex items-center gap-3 border-t border-line px-3 py-1.5 font-mono text-micro text-mute">
          <span>↑↓ move</span>
          <span>↵ open</span>
          <span>⇧↵ beside</span>
          <span className="ml-auto">esc</span>
        </div>
      </div>
    </div>
  );
}

/**
 * One result: the name, then where it lives.
 *
 * A path answers two questions and they deserve different weights. *Which file*
 * is the name, and it is what somebody is scanning for; *which one of the four
 * called `index.ts`* is the directory, and it only matters once the name has
 * already matched.
 */
function Hit({
  path,
  on = false,
  onClick,
  onHover,
}: {
  path: string;
  on?: boolean;
  onClick: () => void;
  onHover?: () => void;
}) {
  const cut = path.lastIndexOf("/");
  const name = cut === -1 ? path : path.slice(cut + 1);
  const dir = cut === -1 ? "" : path.slice(0, cut);

  return (
    <button
      onClick={onClick}
      onMouseMove={onHover}
      title={path}
      className={`flex h-7 w-full items-center gap-2 rounded-sm px-1.5 text-left transition-colors ${
        on ? "bg-raise" : "hover:bg-raise/60"
      }`}
    >
      <FileGlyph name={name} size={14} />
      <span className={`shrink-0 truncate text-ui ${on ? "text-bone" : "text-text"}`}>{name}</span>
      {dir && <span className="min-w-0 flex-1 truncate text-meta text-mute">{dir}</span>}
    </button>
  );
}

/** A value that stops changing while somebody is still typing. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);

  return settled;
}
