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

/** Which workspace the island was clicked on. */
export type IslandTarget = { serverId: string; workspaceId: string };

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
  /**
   * The pill above every other window.
   *
   * This file is meant to stay small and adding to it is meant to cost an
   * argument, so here is the argument. It is one member, not four: the island
   * is a single concept and `secrets` set the precedent for grouping one under
   * a namespace. It adds no new *kind* of power — state goes out, a click
   * comes back, and the shell reads neither. And it is the only way to keep
   * the island off the network: the main window already holds every backend on
   * one poll, and a second webview with its own streams is the mistake
   * `src/api/events.ts` documents, made twice.
   *
   * Everything the island needs to be a *window* is in `src/island/shell.ts`
   * instead, because none of it is anything the app asks the shell for.
   */
  island: {
    /** The fleet, as `src/island/state.ts` shapes it. Pushed, never polled. */
    push(state: unknown): void;
    /** A row was clicked over there. Returns the way to stop listening. */
    onOpen(handler: (target: IslandTarget) => void): () => void;
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
  island: null,
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
    island: {
      push: (state) => void invoke("island_push", { state }),
      onOpen: (handler) => {
        let off = () => {};
        let alive = true;
        void import("@tauri-apps/api/event")
          .then(({ listen }) =>
            listen<IslandTarget>("island://open", (e) => handler(e.payload)),
          )
          .then((stop) => (alive ? (off = stop) : stop()));
        return () => {
          alive = false;
          off();
        };
      },
    },
  };
}

export const bridge: Bridge = tauri() ?? browser;
