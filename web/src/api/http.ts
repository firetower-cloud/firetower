/**
 * The only place in the web application that knows about transport.
 *
 * Every generated call routes through here, which is what lets one bundle serve
 * both a local install and a hosted deployment: the API base is configuration,
 * never an assumption that it shares an origin with the page. The bearer token
 * exists locally too, so there is one auth path rather than an untested second
 * one for production.
 */

const DEFAULT_BASE = "http://localhost:4400";

export function apiBase(): string {
  // Set while developing, when the interface is on its own port.
  const configured = process.env.NEXT_PUBLIC_FIRETOWER_API;
  if (configured) return configured.replace(/\/$/, "");

  // Served by the control plane itself: same origin.
  if (typeof window !== "undefined") {
    // A dev server answering its own /api/* is the misconfiguration that looks
    // like a broken backend: every request 404s from Next rather than reaching
    // the control plane. Say so once, plainly.
    if (process.env.NODE_ENV === "development" && !warnedAboutBase) {
      warnedAboutBase = true;
      console.warn(
        "[firetower] NEXT_PUBLIC_FIRETOWER_API is not set, so API calls are " +
          `going to ${window.location.origin} — the interface's own dev server, ` +
          "which will 404 them. Start with `just dev`, or set it in web/.env.development.",
      );
    }
    return window.location.origin;
  }

  return DEFAULT_BASE;
}

let warnedAboutBase = false;

export function wsBase(): string {
  return apiBase().replace(/^http/, "ws");
}

/**
 * Handed to the app once, then kept. The command line prints a URL carrying it
 * so the first visit does this without anyone typing a token.
 */
export function token(): string | null {
  if (typeof window === "undefined") return null;

  const fromUrl = new URLSearchParams(window.location.search).get("t");
  if (fromUrl) {
    window.localStorage.setItem("firetower.token", fromUrl);
    // don't leave it in the address bar, or in whatever copies that URL
    const clean = new URL(window.location.href);
    clean.searchParams.delete("t");
    window.history.replaceState({}, "", clean);
    return fromUrl;
  }

  return window.localStorage.getItem("firetower.token");
}

/** Every non-success response. The `code` is what the interface switches on. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }

  static async from(res: Response): Promise<ApiError> {
    try {
      const body = await res.json();
      return new ApiError(body.code ?? "Internal", body.message ?? res.statusText, res.status);
    } catch {
      return new ApiError("Internal", res.statusText || "request failed", res.status);
    }
  }
}

/**
 * Called by every generated operation as `http(url, requestInit)`. The URL
 * arrives already built, including its query string.
 */
export const http = async <T>(url: string, init: RequestInit = {}): Promise<T> => {
  // Merged through Headers rather than object spread: spreading leaves both
  // `content-type` and `Content-Type` in place, and fetch joins same-named
  // headers with a comma. The server then sees `application/json,
  // application/json` and rejects it — which broke every request with a body.
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");

  const auth = token();
  if (auth) headers.set("authorization", `Bearer ${auth}`);

  const res = await fetch(`${apiBase()}${url}`, { ...init, headers });

  if (!res.ok) throw await ApiError.from(res);

  // 202 and 204 carry nothing to parse.
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as T;
  }

  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
};
