"use client";

/**
 * A workspace with one column: a header, a switcher, and one of four things.
 *
 * This is what the workbench is below `xl` — a phone, and every iPad but the
 * 13" in landscape. Not a reduced version of the desk layout: the desk shows a
 * rail, two panes and a panel at once because it has 1280px to do it in, and
 * the honest answer at 400px or at 1000px is one surface at a time with a way
 * to change which.
 *
 * The conversation stays mounted while you are in Diff or Ship. It holds an
 * event stream and a socket, and tearing those down to look at a file list —
 * then rebuilding them and repainting the transcript on the way back — is the
 * difference between a switcher and navigation. It is the same rule the desk's
 * `Pane` follows for its tabs, for the same reason.
 */

import { useEffect, useRef } from "react";
import { useSessionDiff } from "@/src/api/generated/sessions/sessions";
import { useScreen } from "@/src/workspace/screen";
import { useOverlay } from "@/src/workspace/overlay";
import { useNoZoom } from "@/src/workspace/touch";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { WorkspaceView } from "./Views";
import { SessionTab } from "./SessionTab";
import { Pushed } from "./Pushed";

export function OneColumn({
  sessionId,
  onBack,
}: {
  sessionId: string;
  onBack: () => void;
}) {
  const { screen, show } = useScreen();
  const { overlay, close } = useOverlay();
  const surface = useRef<HTMLDivElement>(null);

  // Pinch is a fumbled scroll in here. The CSS half is `.no-zoom`; this is the
  // half Safari needs. See `touch.ts` — neither works alone.
  useNoZoom(surface);

  // Asked once and read twice: the count on `Diff`, and the marks in the tree.
  // React Query serves both from one cache entry.
  const { data: files = [] } = useSessionDiff(sessionId, undefined, {
    query: { refetchInterval: 8_000 },
  });

  // A document belongs to the workspace it was opened from. Moving to another
  // one and finding somebody else's diff still on top would be the app losing
  // track of where it is.
  useEffect(() => close(), [sessionId, close]);

  return (
    <div ref={surface} className="no-zoom relative flex min-w-0 flex-1 flex-col overflow-hidden">
      <WorkspaceHeader sessionId={sessionId} changed={files.length} onBack={onBack} />

      <div className="relative min-h-0 flex-1">
        {/* Mounted always, hidden when it is not the one in front. */}
        <div className={`absolute inset-0 ${screen === "chat" ? "" : "hidden"}`}>
          <SessionTab sessionId={sessionId} />
        </div>

        {screen !== "chat" && (
          <div className="absolute inset-0 flex flex-col overflow-hidden bg-panel">
            <WorkspaceView
              view={screen}
              sessionId={sessionId}
              changed={new Set(files.map((f) => f.path))}
              onShip={() => show("ship")}
            />
          </div>
        )}

        {overlay && <Pushed sessionId={sessionId} overlay={overlay} />}
      </div>
    </div>
  );
}
