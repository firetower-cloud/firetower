"use client";

/**
 * A file, a diff or a preview, over the workspace it came from.
 *
 * The desk opens these beside the conversation. One column cannot, so they are
 * pushed on top with a `‹` that goes back to the list they were opened from —
 * which is the list that is still mounted underneath, on the screen it was
 * left on. Nothing is lost and nothing needs remembering.
 *
 * See `overlay.ts` for why this is not a tab.
 */

import { useEffect } from "react";
import { ChevronLeft } from "lucide-react";
import { Icon } from "@/components/ui";
import { FileTab } from "./FileTab";
import { DiffTab } from "./DiffTab";
import { PreviewTab } from "./PreviewTab";
import { leafOf } from "@/src/api/text";
import { useOverlay, type Overlay } from "@/src/workspace/overlay";
import { useDismissible } from "@/src/workspace/dismissible";

export function Pushed({ sessionId, overlay }: { sessionId: string; overlay: Overlay }) {
  const { close } = useOverlay();

  // Back closes the document rather than leaving the workspace, which is what
  // it means on every phone anybody has ever used.
  useDismissible(true, close, "pushed");

  // Escape too, for the tablet band — this is not only a phone component, and
  // a keyboard is normal at 1000px.
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [close]);

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-ground">
      {/* The inset goes on the wrapper, not on the row. A fixed height with
          `box-sizing: border-box` absorbs padding rather than growing by it, so
          the two together squash the bar's contents under the notch instead of
          clearing it. */}
      <header className="shrink-0 border-b border-line bg-panel pt-[env(safe-area-inset-top)]">
        <div className="flex h-13 items-center gap-1 px-1">
          <button
            onClick={close}
            aria-label="Back"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-dim transition-colors hover:bg-raise hover:text-bone"
          >
            <Icon of={ChevronLeft} size={20} />
          </button>
          <div className="min-w-0 flex-1 px-1">
            <p className="truncate font-mono text-ui text-bone">{title(overlay)}</p>
            {overlay.kind !== "preview" && (
              <p className="truncate font-mono text-micro text-mute">{overlay.path}</p>
            )}
          </div>
        </div>
      </header>

      {/* Each of these draws its own bar of controls, which is what it always
          did in a tab. `bare` drops the parts that only make sense beside
          something else — opening in a split, mainly. */}
      <div className="relative min-h-0 flex-1">
        {overlay.kind === "file" && <FileTab sessionId={sessionId} path={overlay.path} />}
        {overlay.kind === "diff" && <DiffTab sessionId={sessionId} path={overlay.path} bare />}
        {overlay.kind === "preview" && <PreviewTab sessionId={sessionId} port={overlay.port} />}
      </div>
    </div>
  );
}

function title(overlay: Overlay): string {
  return overlay.kind === "preview" ? `Preview ${overlay.port}` : leafOf(overlay.path);
}
