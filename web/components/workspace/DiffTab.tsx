"use client";

import { useSessionDiff } from "@/src/api/generated/sessions/sessions";
import { ApiError } from "@/src/api/http";
import { useOpen, useTabs } from "@/src/workspace/tabs";

/**
 * What changed in one file.
 *
 * One file rather than the whole list, because the list already exists in the
 * panel on the right — and a tab that reproduced it would mean two places to
 * choose a file and a selection that disagreed between them.
 */
export function DiffTab({ sessionId, path }: { sessionId: string; path: string }) {
  const { data: files = [], isLoading, error } = useSessionDiff(sessionId, undefined, {
    query: { refetchInterval: 8_000 },
  });
  const { set } = useTabs();
  const open = useOpen();

  const file = files.find((f) => f.path === path);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-slate" title={path}>
          {path}
        </span>
        {file && (
          <>
            <span className="shrink-0 font-mono text-[10.5px] text-sage">+{file.added}</span>
            <span className="shrink-0 font-mono text-[10.5px] text-brick">−{file.removed}</span>
          </>
        )}
        <button
          onClick={() => open.file(path)}
          title="Open the file itself"
          className="shrink-0 text-[11px] text-mute transition-colors hover:text-ember"
        >
          ▤
        </button>
        {!set?.split && (
          <button
            onClick={() => open.diff(path, true)}
            title="Open beside"
            className="shrink-0 text-[12px] text-mute transition-colors hover:text-ember"
          >
            ⊞
          </button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading && <Note>Reading the workspace…</Note>}
        {error && (
          <Note>{error instanceof ApiError ? error.message : "Couldn't read the changes."}</Note>
        )}
        {!isLoading && !error && !file && (
          <Note>
            Nothing has changed in that file — it may have been committed, or reverted, since this
            tab was opened.
          </Note>
        )}
        {file && (
          <pre className="px-3 py-2 font-mono text-[11.5px] leading-[1.6]">
            {file.patch.split("\n").map((line, i) => (
              <div key={i} className={colour(line)}>
                {line || " "}
              </div>
            ))}
          </pre>
        )}
      </div>
    </div>
  );
}

/** Added, removed, and the scaffolding around them. */
function colour(line: string) {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-mute";
  if (line.startsWith("+")) return "bg-sage/[0.07] text-sage";
  if (line.startsWith("-")) return "bg-brick/[0.07] text-brick";
  if (line.startsWith("@@")) return "text-ember/70";
  if (line.startsWith("diff --git") || line.startsWith("index ")) return "text-mute";
  return "text-dim";
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-8">
      <p className="max-w-[44ch] text-center text-[13px] text-mute">{children}</p>
    </div>
  );
}
