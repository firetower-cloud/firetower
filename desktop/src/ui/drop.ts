/**
 * Dragging a file into the app.
 *
 * Two things had to be true and neither was.
 *
 * 1. **Tauri has to let go of the drop.** `dragDropEnabled` defaults to `true`,
 *    which puts wry's own OS-level handler on the webview and stops HTML5
 *    `dragover` / `drop` from ever reaching the page — so the handlers the
 *    composer already had were dead code. It is off in `tauri.conf.json` *and*
 *    `tauri.macos.conf.json`, because platform config is a JSON merge patch and
 *    the `windows` array is replaced whole rather than merged per key.
 * 2. **The target has to be worth aiming at.** The composer box is a thin strip
 *    at the bottom; the conversation above it is where a hand goes. So the
 *    surface is the whole chat pane, and there is exactly one of them — `drop`
 *    bubbles, and a second handler on the composer inside it would attach every
 *    file twice.
 *
 * The counting is the other half. `dragleave` fires when the pointer crosses
 * into a *child*, so a single boolean flickers the overlay off as soon as you
 * reach the textarea. Depth is counted instead, and the counter is a pure
 * function so that behaviour is a test rather than something to watch for.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";

/** What a dropped payload turned out to be. Folders are named, not attached. */
export type Dropped = { files: File[]; folders: string[] };

/** A file drag, as opposed to dragging a selection across the conversation. */
export function carriesFiles(dt: Pick<DataTransfer, "types"> | null): boolean {
  return [...(dt?.types ?? [])].includes("Files");
}

/**
 * The files in a drop, with folders pulled out.
 *
 * A dropped folder arrives in `files` as a zero-byte `File` with an empty
 * `type` — indistinguishable from an empty extensionless file, and uploading it
 * fails with nothing useful to say. `webkitGetAsEntry` is the only thing that
 * knows, and it is only readable while the event is being handled, so this runs
 * synchronously off the event and not a tick later.
 */
export function filesFrom(dt: DataTransfer | null): Dropped {
  const files = [...(dt?.files ?? [])];
  /* `DataTransferItemList` is indexed but not iterable — spreading it throws.
     It is also absent on older WebKit, which is the fallback below. */
  const list = dt?.items;
  if (!list || list.length !== files.length) return { files, folders: [] };
  const items = Array.from({ length: list.length }, (_, i) => list[i]);

  const kept: File[] = [];
  const folders: string[] = [];
  items.forEach((item, i) => {
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) folders.push(entry.name || files[i].name);
    else kept.push(files[i]);
  });
  return { files: kept, folders };
}

/** How many nested elements the drag is currently inside. */
export function depth(was: number, move: "enter" | "leave" | "reset"): number {
  if (move === "reset") return 0;
  return Math.max(0, was + (move === "enter" ? 1 : -1));
}

/** What to say about a folder someone aimed at the conversation. */
export const folderRefusals = (folders: string[]) =>
  folders.map((name) => `${name} is a folder. Attach the files inside it, or ask the agent to look at the path.`);

/**
 * A surface that accepts dropped files.
 *
 * `over` is for the overlay; `surface` spreads onto the element. The handlers
 * are deliberately on one element high up rather than on each part of the pane.
 * `enabled` false makes it inert — the drag is not acknowledged at all, which
 * is the honest answer when there is nothing that could accept the file.
 */
export function useFileDrop(onFiles: (dropped: Dropped) => void, enabled = true) {
  const inside = useRef(0);
  const [over, setOver] = useState(false);

  const reset = useCallback(() => {
    inside.current = depth(inside.current, "reset");
    setOver(false);
  }, []);

  /* A drag can end without this window hearing the end of it — dropped on
     another app, or cancelled with the pointer outside. Same reasoning as
     `release()` in `~/drag`. */
  useEffect(() => {
    window.addEventListener("dragend", reset);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("dragend", reset);
      window.removeEventListener("blur", reset);
    };
  }, [reset]);

  return {
    over: over && enabled,
    surface: {
      onDragEnter: (e: ReactDragEvent<HTMLElement>) => {
        if (!enabled || !carriesFiles(e.dataTransfer)) return;
        e.preventDefault();
        inside.current = depth(inside.current, "enter");
        setOver(true);
      },
      onDragOver: (e: ReactDragEvent<HTMLElement>) => {
        if (!enabled || !carriesFiles(e.dataTransfer)) return;
        // Both: without the default stopped the webview navigates to the file,
        // and without the effect set the cursor reads as a move.
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        if (!over) setOver(true);
      },
      onDragLeave: (e: ReactDragEvent<HTMLElement>) => {
        if (!enabled || !carriesFiles(e.dataTransfer)) return;
        inside.current = depth(inside.current, "leave");
        if (inside.current === 0) setOver(false);
      },
      onDrop: (e: ReactDragEvent<HTMLElement>) => {
        if (!enabled || !carriesFiles(e.dataTransfer)) return;
        e.preventDefault();
        const dropped = filesFrom(e.dataTransfer);
        reset();
        if (dropped.files.length || dropped.folders.length) onFiles(dropped);
      },
    },
  } as const;
}

/**
 * Everywhere else in the window, a dropped file does nothing.
 *
 * The default is for the webview to navigate to it, which replaces the app with
 * the contents of a zip — and a window with no browser chrome has no way back.
 * A drop that was handled has already had its default stopped by the time it
 * reaches the document, so this only catches the misses.
 *
 * **Files only.** Dragging a selection into the composer is an ordinary thing a
 * text box does for free, and blanket-stopping `dragover` would take it away.
 *
 * Installed once, like `catchExternalLinks` in `~/open`.
 */
export function refuseStrayDrops() {
  /* Stopping `dragover` is what makes the document a drop target at all, and
     being one is what lets `drop` be stopped in turn. So the cursor is told
     `none` in the same breath, or every corner of the window would offer to
     take the file and then quietly eat it. */
  document.addEventListener("dragover", (e) => {
    if (e.defaultPrevented || !carriesFiles(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
  });
  document.addEventListener("drop", (e) => {
    if (e.defaultPrevented || !carriesFiles(e.dataTransfer)) return;
    e.preventDefault();
  });
}
