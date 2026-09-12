/**
 * The entire surface that differs between Tauri and Electron.
 *
 * Everything above this line — components, mocks, the style page — is the same
 * either way. Keeping the surface this small is what makes the shell decision
 * reversible in a day rather than a week, so it should stay small: if something
 * wants to be added here, that is worth an argument.
 *
 * There are two implementations. The Tauri one talks to the Rust shell; the
 * browser one is a no-op so `pnpm dev` renders in an ordinary tab, which is how
 * the design iterates without waiting on a native build.
 */
export type WindowState = { width: number; height: number; x?: number; y?: number };

export interface Bridge {
  /** Whether we are inside the native shell at all. */
  native: boolean;
  setTitle(title: string): void;
  /** Ember, on the dock. The count is across every backend. */
  setBadge(count: number | null): void;
  notify(title: string, body: string): void;
  minimize(): void;
  zoom(): void;
}

const browser: Bridge = {
  native: false,
  setTitle: (t) => void (document.title = t),
  setBadge: () => {},
  notify: () => {},
  minimize: () => {},
  zoom: () => {},
};

function tauri(): Bridge | null {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (!w.__TAURI_INTERNALS__) return null;

  // Imported lazily so the browser build never pulls the native API in.
  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    const api = await import("@tauri-apps/api/core");
    return api.invoke(cmd, args);
  };

  return {
    native: true,
    setTitle: (title) => void invoke("set_title", { title }),
    setBadge: (count) => void invoke("set_badge", { count }),
    notify: (title, body) => void invoke("notify", { title, body }),
    minimize: () => void invoke("minimize"),
    zoom: () => void invoke("zoom"),
  };
}

export const bridge: Bridge = tauri() ?? browser;
