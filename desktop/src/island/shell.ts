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

/**
 * Where a pill that has never been dragged starts out.
 *
 * The top, on both. It was the corner on Windows, and the argument was a good
 * one — no notch, no convention of a thing at the top middle, and everything
 * ambient on that platform living by the clock. But the island is the same
 * object on both, and a pill that starts by the tray on one and under the
 * menu bar on the other is two products wearing one name. `corner` stays
 * because the placement maths still knows how, and a drag can still put it
 * there.
 */
export const anchor: Anchor = "top";

export async function screens(): Promise<Screen[]> {
  if (!invoke) return [];
  return (await invoke("island_screens")) as Screen[];
}

/**
 * The display this window is on, as the webview understands it.
 *
 * A fallback, and the difference between a degraded island and no island at
 * all. Everything downstream needs at least one display: with none, the
 * placement declines to place, the window is never shown, and nothing says
 * why — which is what "it is absolutely nowhere" looks like from outside.
 * The shell asking the system for its monitors is one call that can fail, and
 * when it does there is still a screen right here to be measured.
 *
 * Only ever one, and only the one the window is already on: `screen` knows
 * nothing about the others. That is enough to dock to the top of it, which
 * is the common case this rescues — a machine with a single display, where
 * the answer was never in doubt.
 */
export function hereabouts(): Screen[] {
  if (typeof window === "undefined" || !window.screen) return [];
  const per = unit();
  const it = window.screen as Screen0;
  const px = (n: number | undefined, or = 0) => Math.round((n ?? or) * per);

  const x = px(it.availLeft);
  const y = 0;
  const width = px(it.width);
  const height = px(it.height);
  if (width < 2 || height < 2) return [];

  return [
    {
      name: "this display",
      primary: true,
      x,
      y,
      width,
      height,
      workX: x,
      workY: px(it.availTop),
      workWidth: px(it.availWidth, it.width),
      workHeight: px(it.availHeight, it.height),
      // No cutout is knowable from here, and the platforms that have one
      // never take this path.
      notchWidth: 0,
      notchHeight: 0,
    },
  ];
}

/** `availLeft` and `availTop` are not in the DOM types, and are in Chromium. */
type Screen0 = globalThis.Screen & { availLeft?: number; availTop?: number };

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
 * Let the mouse through the transparent part of the stage.
 *
 * See `island_click_through`: the window is the size of the largest panel and
 * never changes, so most of it is transparent and must not swallow clicks
 * meant for the menu bar behind it.
 */
export async function clickThrough(ignore: boolean): Promise<void> {
  if (!invoke) return;
  await invoke("island_click_through", { ignore });
}

/**
 * Come forward, so the pointer works inside the expanded panel.
 *
 * See `island_activate`, which explains why a window built never to take
 * focus asks for it at exactly this moment and no other.
 */
export async function activate(): Promise<void> {
  if (!invoke) return;
  await invoke("island_activate");
}

/**
 * Which part of the window is the pill, for the shell to test the pointer in.
 *
 * The window is routinely bigger: the melting corners hang outside the pill,
 * and a collapse leaves the panel's rectangle in place for as long as the
 * animation runs. All of that is transparent, and none of it should count as
 * being on the island.
 */
export async function hit(rect: Rect): Promise<void> {
  if (!invoke) return;
  await invoke("island_hit", rect);
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
export async function pointerInside(): Promise<boolean | null> {
  // `null` and not `false`: "there is no shell to ask" and "the pointer is
  // not on it" are different answers, and only the first one means the
  // document's own `:hover` is still needed.
  if (!invoke) return null;
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
