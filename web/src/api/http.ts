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
 * Where the application is, for the two screens that finish by leaving.
 *
 * **A document load, not the router.** `/` is served by the renderer — a
 * different application, built by Vite and embedded beside this one
 * (`crates/ft-server/src/web.rs`) — so there is no Next route behind it for
 * `router.replace("/")` to reach. Both screens below used to do exactly that,
 * which asks this site's client router for a page this site does not export:
 * no document is fetched, so the renderer never loads.
 *
 * `replace` rather than `assign` so Back does not return to the screen that
 * has just finished with you, which is what `router.replace` was for. The Next
 * lint rule against navigating by `location` does not fire on it and would be
 * wrong here if it did: the whole point is that this destination is not an
 * internal Next page.
 *
 * One function rather than the line written twice, because it was written
 * twice and only one of the two was ever found.
 */
export function toApplication() {
  leaveFor("/");
}

/**
 * Load a path from this origin, letting the server decide which bundle it is.
 *
 * The same document load as [`toApplication`], for a path that is not known in
 * advance: `/account` is this site's and `/` is the renderer's, and only the
 * server knows which is which. One rule rather than a choice between the
 * client router and a load, because getting that choice wrong is silent —
 * the router renders nothing and fetches nothing.
 */
export function leaveFor(path: string) {
  if (typeof window === "undefined") return;
  window.location.replace(path);
}

/**
 * Where somebody asked to be put back, if it is a place we may put them.
 *
 * **This is a redirect target supplied by whoever wrote the link, which is the
 * shape of an open redirect.** A sign-in page that will forward to any address
 * it is handed is a phishing primitive: the link is genuinely ours, the
 * password is genuinely typed into our form, and the landing is somebody
 * else's. So the answer is a bare path on this origin or nothing, and it is
 * three checks rather than one because each of them lets a different thing
 * through:
 *
 * 1. **It must be written as a bare path.** `https://evil.example/x` and
 *    `account` are both rejected here — the first is another origin and the
 *    second is a relative reference whose meaning depends on where it is
 *    read.
 * 2. **It must still be this origin once resolved.** `//evil.example/x` is a
 *    protocol-relative URL and `/\evil.example` is one too, because a browser
 *    normalises the backslash. Both begin with `/` and neither is ours. The
 *    URL parser is what settles this, rather than a list of prefixes to
 *    forget one of.
 * 3. **What comes out must be a bare path as well.** `/..//evil.example`
 *    passes the first two — it is written as a path and resolves to this
 *    origin — and its *pathname* is `//evil.example`, which is protocol-
 *    relative all over again the moment it is handed to `location`. A check
 *    on the input alone would have shipped the hole it was written to close.
 *
 * Nothing about who may sign in, what a session is or where a token lives is
 * touched by any of this. It decides one thing: which of two screens somebody
 * is looking at a second after they sign in.
 */
export function returnPath(raw: string | null | undefined, origin: string): string | null {
  if (!raw || !raw.startsWith("/")) return null;
  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    return null;
  }
  if (url.origin !== new URL(origin).origin) return null;
  const path = `${url.pathname}${url.search}${url.hash}`;
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  return path;
}

/** Where a successful sign-in puts somebody. */
export type Landing = { to: "setup" } | { to: "load"; path: string };

/**
 * The order the three destinations are asked in, as a rule rather than as a
 * comment on an `if`.
 *
 * **Setting up outstanding comes first and `?next=` cannot overtake it.**
 * Somebody who still owes a password is refused every request until it is
 * replaced, so forwarding them to the page they asked for would land them on
 * one that immediately bounces them back here — and `?next=` is written by
 * whoever made the link, which is not a thing that may route around a gate.
 * Then where they were going, if it is somewhere they may be sent. Then the
 * application.
 *
 * A function rather than the `if` it replaces because the precedence is the
 * part worth being sure of, and an ordering inside a mutation callback behind
 * a real password cannot be driven in a test.
 */
export function afterSignIn(outstanding: boolean, search: string, origin: string): Landing {
  if (outstanding) return { to: "setup" };
  return { to: "load", path: returnPath(new URLSearchParams(search).get("next"), origin) ?? "/" };
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
    // **With where they were, so they can be put back.** `/account` is the
    // only voluntary password form in the product and it needs a session,
    // which a browser arriving from the desktop app's *change password*
    // button does not have — so without this it bounced here and signing in
    // returned them to the application, and the form was unreachable from the
    // one control that offers it. The same sentence covers an ordinary
    // session ending while somebody is standing on a page.
    //
    // The path only. A query string on the screen somebody was refused from
    // is not needed to put them back on it, and the fewer characters that
    // make the round trip the less there is for `returnPath` to have to
    // reason about.
    const next = encodeURIComponent(window.location.pathname);
    // A full load on purpose: this runs when a session has just ended, and the
    // router would keep every cached query belonging to whoever was signed in.
    // Clearing that is the point.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign(`/login?next=${next}`);
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
 * Whether a refusal means this browser is no longer signed in.
 *
 * The **code**, never the status. Signing somebody out is the most destructive
 * thing a failed request can do — the token is thrown away and every cached
 * query with it — and the status is shared between codes that mean entirely
 * different things. `ProviderNotConnected` and `RepoAccessDenied` both answered
 * 401 once, so a GitHub authorization nobody had done yet, or one private
 * repository the token could not see, signed the person out of Firetower. The
 * tasks list, the repository picker and the issue chips all ask for those
 * without being told to — the chips while somebody is typing — so it read as
 * being logged out at random.
 *
 * The server no longer answers 401 for either. This does not rely on that: an
 * interface served from a newer build than the control plane behind it is an
 * ordinary state during an upgrade, and the code is what both versions agree on.
 *
 * Signing in is exempt because a refused password is the answer to the question
 * that screen is asking, not a session ending underneath it.
 */
export function meansSignedOut(code: string, url: string): boolean {
  return code === "Unauthorized" && !url.startsWith("/api/v1/auth/login");
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
    if (meansSignedOut(error.code, url)) {
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
