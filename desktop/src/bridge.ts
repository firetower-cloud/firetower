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

/**
 * How far along a save is.
 *
 * Two phases rather than one spinner because the first can be the long one and
 * looks identical to a stall: a directory of video is deflated on the worker
 * before a single byte is sent, and "Downloading…" during it is both wrong and
 * the thing somebody stares at wondering whether it has hung.
 *
 * The boundary is not guessed. The archive endpoint cannot answer until the
 * zip is finished — it owes the response a `content-length` — so the arrival
 * of the headers *is* the moment compressing stopped.
 *
 * A plain file has no compressing phase; its caller starts at `downloading`.
 */
export type SavePhase = "compressing" | "downloading";

/**
 * Whatever a rejection was, as something with a `.message`.
 *
 * **Tauri rejects a `Result::Err(String)` with the bare string.** Every reader
 * of a failure in this app asks for `.message` — `why()` does — and a string
 * has none, so the server's own sentence was dropped and drawn as the
 * house fallback, "That didn't work."
 *
 * The one that matters is the size limit: it names the file, how big it is and
 * what to do instead, and losing it leaves somebody looking at a download that
 * failed for no stated reason.
 */
export function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

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
  /**
   * Save a URL to a path somebody picks. `null` if they dismissed the sheet.
   *
   * Here rather than in a component because it is the one thing in the file's
   * remit that a browser genuinely cannot do: a tab downloads to wherever the
   * browser is configured to, and a window has to ask. The two implementations
   * below are *not* the same gesture dressed differently — one streams through
   * the shell to a chosen path, the other hands the browser a blob — which is
   * exactly the kind of difference this file exists to hold.
   */
  save(
    url: string,
    suggested: string,
    token: string | null,
    onPhase?: (phase: SavePhase) => void,
  ): Promise<string | null>;
  /**
   * Photograph a page, as PNG bytes.
   *
   * `null` where there is no native shell to render in — a browser tab cannot
   * read the pixels of a cross-origin frame, and an artifact is deliberately
   * on an origin of its own. The library draws its placeholder in that case,
   * which is the same thing it draws before a picture has been taken.
   */
  shoot(url: string): Promise<ArrayBuffer | null>;
  /**
   * An artifact's HTML, read natively so a secure webview can show it.
   *
   * A browser tab (`null`) loads the artifact URL straight into the iframe and
   * keeps the annotation picker. The native shell is a *secure* context and a
   * dev artifact is plain http, which a secure page refuses to frame — mixed
   * content — so the shell fetches the bytes here, where that rule does not
   * apply, and the renderer drops them into a `srcdoc` frame instead.
   */
  loadArtifact: ((url: string) => Promise<string>) | null;
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
  /* An anchor with `download` on it, which is how a tab saves anything. The
     bytes come through `fetch` rather than by pointing the anchor at the URL,
     because the request needs an `authorization` header and an anchor cannot
     carry one — it would navigate to a 401. */
  save: async (url, suggested, token, onPhase) => {
    const answer = await fetch(url, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    });
    if (!answer.ok) {
      const body = await answer.json().catch(() => null);
      throw new Error(body?.message ?? `Firetower answered ${answer.status}.`);
    }
    // Headers are in, so the worker has finished building whatever this is.
    onPhase?.("downloading");
    const href = URL.createObjectURL(await answer.blob());
    const a = document.createElement("a");
    a.href = href;
    a.download = suggested;
    a.click();
    // Not immediately: revoking before the click has been acted on cancels
    // the download it was for.
    setTimeout(() => URL.revokeObjectURL(href), 30_000);
    return suggested;
  },
  shoot: async () => null,
  loadArtifact: null,
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
    save: async (url, suggested, token, onPhase) => {
      const api = await import("@tauri-apps/api/core");
      const channel = new api.Channel<SavePhase>();
      if (onPhase) channel.onmessage = onPhase;
      try {
        return (await api.invoke("save_download", {
          url,
          suggested,
          token,
          onPhase: channel,
        })) as string | null;
      } catch (e) {
        throw asError(e);
      }
    },
    loadArtifact: (url) => invoke("load_artifact", { url }) as Promise<string>,
    shoot: async (url) => {
      const bytes = await invoke("capture_poster", { url });
      /* Tauri hands a `Response` back as an ArrayBuffer, but a failure that
         slipped through as something else should draw the placeholder rather
         than be uploaded as a poster. */
      return bytes instanceof ArrayBuffer ? bytes : null;
    },
    secrets: {
      get: (key) => invoke("secret_get", { key }) as Promise<string | null>,
      set: (key, value) => invoke("secret_set", { key, value }) as Promise<void>,
      delete: (key) => invoke("secret_delete", { key }) as Promise<void>,
    },
  };
}

export const bridge: Bridge = tauri() ?? browser;
