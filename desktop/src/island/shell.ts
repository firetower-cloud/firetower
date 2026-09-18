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
import type { Rect, Screen } from "./place";
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
