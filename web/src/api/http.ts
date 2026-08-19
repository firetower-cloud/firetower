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

const TOKEN_KEY = "firetower.token";

/**
 * The session, from signing in.
 *
 * Kept in local storage rather than a cookie: development runs the interface on
 * :3000 and the API on :4400, which makes every cookie cross-site, while
 * production is same-origin. One of those would have to behave differently, and
 * the auth path that is exercised every day should be the one that ships.
 */
export function token(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function rememberToken(value: string) {
  window.localStorage.setItem(TOKEN_KEY, value);
}

export function forgetToken() {
  window.localStorage.removeItem(TOKEN_KEY);
}

/** Where the one thing they are allowed to do lives. */
function toSetup() {
  if (typeof window === "undefined") return;
  if (window.location.pathname !== "/setup") {
    // A full load for the same reason as below: every cached query on this
    // screen was refused, and none of them are worth keeping.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/setup");
  }
}

/**
 * Where to send someone who isn't signed in.
 *
 * A hard assignment rather than the router: this happens from inside a fetch,
 * anywhere in the app, and half-rendered screens holding stale data are worse
 * than one reload.
 */
function toSignIn() {
  if (typeof window === "undefined") return;
  forgetToken();
  if (window.location.pathname !== "/login") {
    // A full load on purpose: this runs when a session has just ended, and the
    // router would keep every cached query belonging to whoever was signed in.
    // Clearing that is the point.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/login");
  }
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

  if (!res.ok) {
    const error = await ApiError.from(res);

    // The session ended, or there never was one. Signing in again is the only
    // thing to do about it, so do that rather than showing every screen its own
    // version of the same message.
    if (error.status === 401 && !url.startsWith("/api/v1/auth/login")) {
      toSignIn();
    }

    // Signed in, and allowed to do exactly one thing until a password that came
    // from a file is replaced. Every other screen would render "can't reach the
    // control plane", which is both wrong and unactionable — the wizard is
    // where this is fixed.
    if (error.code === "PasswordChangeRequired") {
      toSetup();
    }

    throw error;
  }

  // 202 and 204 carry nothing to parse.
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as T;
  }

  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
};
