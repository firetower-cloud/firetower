"use client";

/**
 * Files, Changes and Ship — the three views, without a frame around them.
 *
 * They used to be the inside of `Inspector`, which meant they were the inside
 * of a 320px panel on the right of a wide window, and that was the only place
 * they could ever be. Below `xl` there is no room for that panel, so there was
 * nothing: an iPad in landscape — every model but the 13" is under 1280px
 * there — had no route to a diff or a pull request at all.
 *
 * So the views moved out and the panel became one of two frames around them.
 * The other is the switcher in a workspace's header. Neither frame knows what
 * is inside it and the views do not know which frame they are in; the only
 * thing that differs is how wide they get to be, and they were built to be
 * narrow.
 *
 * Nothing here is a viewer. A file opens a file tab, a change opens a diff
 * tab — in the pane on a desk, as a pushed screen on a phone.
 */

import { useSessionDiff } from "@/src/api/generated/sessions/sessions";
import { useOpen } from "@/src/workspace/tabs";
import type { View } from "@/src/workspace/panel";
import { PathRow, Counts } from "./PathRow";
import { Tree } from "./Tree";
import { ShipPanel } from "./ShipPanel";

export function WorkspaceView({
  view,
  sessionId,
  changed,
  onShip,
}: {
  view: View;
  sessionId: string;
  /** Which paths the agent has touched, for the marks in the tree. */
  changed: Set<string>;
  /** Bring Ship forward — a panel view on a desk, a screen on a phone. */
  onShip: () => void;
}) {
  if (view === "files") return <Tree sessionId={sessionId} changed={changed} />;
  if (view === "changes") return <Changes sessionId={sessionId} onShip={onShip} />;
  return <ShipPanel sessionId={sessionId} />;
}

/** What is in the workspace that is not safely elsewhere. */
export function Changes({
  sessionId,
  onShip,
}: {
  sessionId: string;
  onShip: () => void;
}) {
  // `isError` matters as much as the data. Without it a request that failed
  // was the same empty array as a workspace with nothing in it, and this drew
  // "Nothing has changed yet." over a host that had stopped answering.
  const {
    data: files = [],
    isLoading,
    isError,
  } = useSessionDiff(sessionId, undefined, {
    query: { refetchInterval: 8_000 },
  });
  const open = useOpen();

  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="eyebrow">Changes</span>
        <span className="ml-auto font-mono text-micro text-mute">
          {isLoading
            ? "…"
            : isError
              ? "unknown"
              : files.length === 0
                ? "none"
                : `${files.length} files`}
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

        {!isLoading && isError && (
          <Line>
            Firetower can&rsquo;t reach this session&rsquo;s machine, so it can&rsquo;t say
            what has changed.
          </Line>
        )}
        {!isLoading && !isError && files.length === 0 && (
          <Line>Nothing has changed yet.</Line>
        )}
      </div>

      {files.length > 0 && (
        <div className="shrink-0 border-t border-line px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <p className="mb-2 font-mono text-micro text-mute">
            <span className="text-sage">+{added}</span>{" "}
            <span className="text-brick">−{removed}</span>
          </p>
          <button
            onClick={onShip}
            className="min-h-[44px] w-full rounded-md border border-line text-meta text-dim transition-colors hover:border-line hover:text-bone"
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
