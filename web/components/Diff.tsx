"use client";

import { useState } from "react";
import { useSessionDiff } from "@/src/api/generated/sessions/sessions";
import { ApiError } from "@/src/api/http";

/**
 * What the agent changed, one file at a time.
 *
 * A list beside a patch rather than one long scroll: the question is almost
 * always "what did it touch", and only then "what did it do to this one".
 */
export function Diff({ sessionId }: { sessionId: string }) {
  const [selected, setSelected] = useState<string | null>(null);

  const { data: files = [], isLoading, error } = useSessionDiff(sessionId, undefined, {
    query: { refetchInterval: 8000 },
  });

  if (isLoading) {
    return <Empty>Reading the workspace…</Empty>;
  }

  if (error) {
    return (
      <Empty>
        {error instanceof ApiError ? error.message : "Couldn't read the changes."}
      </Empty>
    );
  }

  if (files.length === 0) {
    return <Empty>Nothing has changed yet.</Empty>;
  }

  const file = files.find((f) => f.path === selected) ?? files[0];

  return (
    <div className="grid h-full min-h-0 grid-cols-[220px_1fr] overflow-hidden rounded-sm border border-line">
      <ul className="min-h-0 overflow-y-auto border-r border-line bg-panel py-1">
        {files.map((f) => (
          <li key={f.path}>
            <button
              onClick={() => setSelected(f.path)}
              className={`flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left transition-colors ${
                f.path === file.path ? "bg-raise" : "hover:bg-raise/60"
              }`}
            >
              <span
                className="min-w-0 flex-1 truncate font-mono text-meta text-dim"
                title={f.path}
              >
                {/* The end of a path identifies it; the start rarely does. */}
                {f.path.split("/").slice(-2).join("/")}
              </span>
              <span className="shrink-0 font-mono text-micro text-sage">+{f.added}</span>
              <span className="shrink-0 font-mono text-micro text-brick">−{f.removed}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="min-h-0 overflow-auto bg-ground">
        <div className="sticky top-0 border-b border-line bg-ground px-3 py-1.5">
          <span className="font-mono text-meta text-slate">{file.path}</span>
        </div>
        <pre className="px-3 py-2 font-mono text-meta leading-[1.6]">
          {file.patch.split("\n").map((line, i) => (
            <div key={i} className={colour(line)}>
              {line || " "}
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}

/** Added, removed, and the scaffolding around them. */
function colour(line: string) {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-mute";
  if (line.startsWith("+")) return "bg-sage/[0.07] text-sage";
  if (line.startsWith("-")) return "bg-brick/[0.07] text-brick";
  if (line.startsWith("@@")) return "text-slate";
  if (line.startsWith("diff --git") || line.startsWith("index ")) return "text-mute";
  return "text-dim";
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center rounded-sm border border-dashed border-line">
      <p className="text-meta text-mute">{children}</p>
    </div>
  );
}
