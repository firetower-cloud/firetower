/**
 * The island's half of the bridge.
 *
 * Kept out of `bridge.ts` on purpose. That file is the surface the *app* needs
 * from the shell and it is deliberately narrow; this is the surface one window
 * needs to be a window, and only `island.html` ever loads it. Putting it there
 * would double the size of the interface the project promised to keep small,
 * to serve a page that is not the app.
 *
 * Everything here is a command in `island.rs` rather than a core Tauri
 * permission, which is why `capabilities/island.json` stays five lines long: a
 * command is code we wrote, not a capability we granted.
 */
import { isMac } from "~/platform";
import type { Anchor, Rect, Screen } from "./place";
import type { IslandState } from "./state";

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

const native = (): Invoke | null => {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (!w.__TAURI_INTERNALS__) return null;
  return async (cmd, args) => {
    const api = await import("@tauri-apps/api/core");
    return api.invoke(cmd, args);
  };
};

const invoke = native();

/** In a plain browser tab — `pnpm dev` at `/island.html` — nothing native answers. */
export const inShell = invoke !== null;

/**
 * CSS pixels to whatever `island_place` is measuring in.
 *
 * One on macOS, where a logical point *is* a CSS pixel and window placement
 * has a single scale for the whole desktop.
 *
 * `devicePixelRatio` on Windows, where it is not: per-monitor DPI means a 4K
 * display at 150% and a 1080p at 100% share no logical space, so `island.rs`
 * reports and accepts device pixels — the only space both agree on. Read
 * fresh each time rather than cached, because dragging the pill from one
 * display to the other changes it underneath us.
 */
export const unit = (): number => (isMac ? 1 : window.devicePixelRatio || 1);

/** Where a pill that has never been dragged starts out on this platform. */
export const anchor: Anchor = isMac ? "top" : "corner";

export async function screens(): Promise<Screen[]> {
  if (!invoke) return [];
  return (await invoke("island_screens")) as Screen[];
}

export async function place(rect: Rect): Promise<void> {
  if (!invoke) return;
  await invoke("island_place", rect);
}

export async function bounds(): Promise<Rect | null> {
  if (!invoke) return null;
  return (await invoke("island_bounds")) as Rect;
}

export async function visible(show: boolean): Promise<void> {
  if (!invoke) return;
  await invoke("island_visible", { show });
}

export async function sharing(hidden: boolean): Promise<void> {
  if (!invoke) return;
  await invoke("island_sharing", { hidden });
}

/**
 * Whether the pointer is over the pill, asked of the shell.
 *
 * `:hover` is not enough. The island never takes focus, and AppKit sends a
 * non-activating window's webview no mouse-moved events until it has been
 * clicked — so the pill would only open once you had already aimed at it
 * twice. The shell knows where the cursor is and where the window is, so it
 * is asked. See `island_pointer`, which explains why this is a poll and not
 * something the shell pushes.
 */
export async function pointerInside(): Promise<boolean> {
  if (!invoke) return false;
  return (await invoke("island_pointer")) === true;
}

/** Bring the app forward, on this workspace. */
export async function open(serverId: string, workspaceId: string): Promise<void> {
  if (!invoke) return;
  await invoke("island_open", { target: { serverId, workspaceId } });
}

/** Hand the window to AppKit for the length of a drag. */
export async function startDragging(): Promise<void> {
  if (!invoke) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().startDragging();
}

/** The fleet, pushed from the main window. */
export async function onState(handler: (s: IslandState) => void): Promise<() => void> {
  if (!invoke) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return await listen<IslandState>("island://state", (e) => handler(e.payload));
}

/**
 * The tray asking to be seen again.
 *
 * The one way back from "hide until something needs you" that does not
 * involve waiting for something to need you. Windows only, because the menu
 * item that sends it is.
 */
export async function onWake(handler: () => void): Promise<() => void> {
  if (!invoke) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return await listen("island://wake", () => handler());
}

/**
 * Every frame of a drag.
 *
 * The webview does not reliably see the `mouseup` that ends a native drag —
 * `src/drag.ts` found that out the hard way — so the end of a drag is inferred
 * from these going quiet rather than from the mouse.
 */
export async function onMoved(handler: () => void): Promise<() => void> {
  if (!invoke) return () => {};
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return await getCurrentWindow().onMoved(() => handler());
}
