/**
 * The entire surface that differs between Tauri and Electron.
 *
 * Everything above this line — components, the style page — is the same
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
  close(): void;
  /** The OS keychain, for tokens. A browser tab has none and keeps them beside the registry. */
  secrets: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  } | null;
}

const browser: Bridge = {
  native: false,
  setTitle: (t) => void (document.title = t),
  setBadge: () => {},
  notify: () => {},
  minimize: () => {},
  zoom: () => {},
  close: () => {},
  secrets: null,
};

function tauri(): Bridge | null {
  // No window under a test runner; the browser bridge is the harmless one.
  if (typeof window === "undefined") return null;
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
    close: () => void invoke("close"),
    secrets: {
      get: (key) => invoke("secret_get", { key }) as Promise<string | null>,
      set: (key, value) => invoke("secret_set", { key, value }) as Promise<void>,
      delete: (key) => invoke("secret_delete", { key }) as Promise<void>,
    },
  };
}

export const bridge: Bridge = tauri() ?? browser;
