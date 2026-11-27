/**
 * Finding out whether there is a Firetower at an address, and what it is.
 *
 * `GET /api/v1/bootstrap` is unauthenticated and cheap, which is what makes it
 * the right first move: the client can name the organisation, the version and
 * how to sign in **before** it asks anybody for a password. Typing the address
 * of the wrong company's Firetower should be caught by reading its name, not by
 * handing it your credentials and seeing what happens.
 */
export type Bootstrap = {
  version: string;
  eventsPath: string;
  serverId?: string | null;
  organization?: string | null;
  authModes: string[];
};

export type Reached =
  | { ok: true; url: string; at: Bootstrap }
  | { ok: false; why: "unreachable" | "refused" | "not-firetower" | "too-old"; detail: string };

/**
 * The oldest control plane this app can talk to.
 *
 * A server that is older answers the web interface and refuses the app: it
 * only sends the cross-origin headers a webview needs from this version on.
 * Rather than let that read as a bad address, the probe names the server's
 * version and says to upgrade it.
 */
export const MIN_SERVER = "0.34.1";

/**
 * The origins a shipped client's pages have, on every platform it runs on.
 *
 * The same list the control plane allows — `ft_server::CLIENT_ORIGINS` — and
 * kept here for one question the app has to answer about itself: *could* a
 * server ever have let us in?
 */
export const PACKAGED_ORIGINS = [
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
];

/**
 * Whether this build's pages come from where a shipped one's do.
 *
 * False in development, where the pages are served by vite on a port of its
 * own. That origin is on no production allowlist and never will be — allowing
 * it would let any page on anybody's dev server call a real control plane — so
 * a refusal there is this build being what it is, not the server being behind.
 * Saying otherwise sent somebody to check the version of a server that was
 * already current.
 */
export function packaged(origin = globalThis.location?.origin ?? ""): boolean {
  return PACKAGED_ORIGINS.includes(origin);
}

/**
 * Which Firetower this client is for, before anybody has been asked anything.
 *
 * **A page served by a control plane already knows the answer.** It was loaded
 * from that control plane's own origin, and the specification is explicit that
 * this is the arrangement — "no address configured at build time; the client
 * reads the API from the origin it was loaded from" — because it is what makes
 * a client and a server impossible to skew. So in a browser the *where*
 * question has an answer before it is asked, and asking it anyway is how a
 * self-hoster's first sight of their own address became a form demanding that
 * address.
 *
 * **Inside the shell it genuinely does not know.** A window loaded from a file
 * is for whichever Firetower somebody points it at, which is the whole of why
 * `Connect` exists and why multi-installation switching exists behind it.
 * Nothing about that changes here: `ask` comes back true and the shell draws
 * exactly the screen it drew before.
 *
 * This answers only the first of `Connect`'s two questions. Who you are, and
 * every mode the server will accept for proving it, is untouched.
 */
export type Own =
  /** Ask where it is, as the app always has. */
  | { ask: true }
  /** Don't: this is the control plane that sent us the page. */
  | { ask: false; url: string };

/**
 * The rule, as a function of what can be observed and nothing else.
 *
 * Takes its inputs rather than reading them so the decision can be read back
 * for every combination that matters — see `probe.test.ts`. [`ownFiretower`]
 * is the one-line reader that feeds it the real window.
 *
 * The order of the refusals is the order of how sure each one is:
 *
 * - **The shell is present.** `__TAURI_INTERNALS__` is this codebase's test for
 *   that already, in `open.ts`, `drag.ts` and `bridge.ts`, and it is the one
 *   that actually means "there is a native shell around this page".
 * - **The origin is one a shipped shell serves itself from.** `packaged()`
 *   above, reused rather than re-derived. Belt and braces behind the first
 *   check, and not redundant: two of the three packaged origins are
 *   `http://tauri.localhost` and `https://tauri.localhost`, which pass every
 *   test below this one. If the native API were ever absent or late on
 *   Windows or Linux, a shell window would otherwise adopt itself as a control
 *   plane and probe `http://tauri.localhost/api/v1/bootstrap`.
 * - **This is a dev build.** The pages come from vite on :5273 and the control
 *   plane is somewhere else entirely — adopting :5273 would point the app at a
 *   bundler. `import.meta.env.DEV` is read by the caller, the same way
 *   `platform.ts` gates its own development-only behaviour, and passed in here
 *   so this function stays pure. (`pnpm preview` is the one gap: it serves a
 *   built bundle from a port that is not a Firetower, so it will try to adopt
 *   itself and land on the existing *could not reach* screen, which offers
 *   "Use a different address". No recipe in the `justfile` runs it, and the
 *   alternative — probing the origin and silently falling back to the form —
 *   is the behaviour this ticket is told not to build.)
 * - **The protocol is not http(s).** `file://` and `tauri://` have no control
 *   plane behind them to adopt.
 */
export function ownFiretowerFrom(seen: {
  protocol: string;
  origin: string;
  /** Whether a native shell is wrapped around this page. */
  shell: boolean;
  /** Whether this bundle came from `vite dev` rather than `vite build`. */
  dev: boolean;
}): Own {
  if (seen.shell) return { ask: true };
  if (packaged(seen.origin)) return { ask: true };
  if (seen.dev) return { ask: true };
  if (seen.protocol !== "http:" && seen.protocol !== "https:") return { ask: true };
  // An origin of `"null"` is what a sandboxed frame reports, and `""` is what
  // there is no window to report. Neither is an address anything can be
  // fetched from.
  if (!seen.origin || seen.origin === "null") return { ask: true };
  return { ask: false, url: seen.origin };
}

/** [`ownFiretowerFrom`], asked of the window this is actually running in. */
export function ownFiretower(): Own {
  if (typeof window === "undefined") return { ask: true };
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  return ownFiretowerFrom({
    protocol: window.location?.protocol ?? "",
    origin: window.location?.origin ?? "",
    shell: !!w.__TAURI_INTERNALS__,
    dev: import.meta.env.DEV,
  });
}

/** `a` is at least `b`, reading the first three dotted numbers of each. */
export function atLeast(a: string, b: string): boolean {
  const num = (v: string) =>
    v
      .split(".")
      .slice(0, 3)
      .map((p) => parseInt(p, 10) || 0);
  const [x, y] = [num(a), num(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return true;
}

/**
 * What somebody typed, as a URL.
 *
 * A bare host is the common case — `ft-e1.tail9c2b.ts.net` is what Tailscale
 * shows you — so a scheme is added rather than demanded. `https` first, because
 * anything reachable over a mesh is usually behind a proxy that has a
 * certificate, and `http` after, because a laptop install is not.
 */
export function candidates(typed: string): string[] {
  const raw = typed.trim().replace(/\/+$/, "");
  if (!raw) return [];
  if (/^https?:\/\//i.test(raw)) return [raw];
  // A port on its own means a local install, which is never https.
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(raw)) return [`http://${raw}`];
  return [`https://${raw}`, `http://${raw}`];
}

/**
 * Whether anything answers at all, asked in a way the engine cannot refuse.
 *
 * A request the server answered without the cross-origin headers a webview
 * needs throws exactly like one nothing answered — the engine hides both
 * behind `Load failed`. Asked again with `no-cors`, the first comes back as an
 * opaque response and the second still throws. That is the difference between
 * a server that refused the app and a route that is missing, and it is the
 * difference between "upgrade your Firetower" and "check the VPN".
 */
async function answers(url: string, signal: AbortSignal): Promise<boolean> {
  try {
    await fetch(`${url}/api/v1/bootstrap`, { signal, mode: "no-cors", redirect: "follow" });
    return true;
  } catch {
    return false;
  }
}

async function ask(url: string, signal: AbortSignal): Promise<Reached> {
  let res: Response;
  try {
    res = await fetch(`${url}/api/v1/bootstrap`, { signal, redirect: "follow" });
  } catch (e) {
    const detail = String((e as Error)?.message ?? e);
    if (await answers(url, signal)) {
      return { ok: false, why: "refused", detail };
    }
    return { ok: false, why: "unreachable", detail };
  }

  if (!res.ok) {
    return { ok: false, why: "not-firetower", detail: `answered ${res.status}` };
  }

  try {
    const at = (await res.json()) as Bootstrap;
    // Something answered; whether it is a Firetower is a different question.
    if (typeof at.version !== "string" || !Array.isArray(at.authModes)) {
      return { ok: false, why: "not-firetower", detail: "that is not a Firetower" };
    }
    if (!atLeast(at.version, MIN_SERVER)) {
      return { ok: false, why: "too-old", detail: `Firetower ${at.version}` };
    }
    return { ok: true, url, at };
  } catch {
    return { ok: false, why: "not-firetower", detail: "that is not a Firetower" };
  }
}

/** Tries each candidate in turn and keeps the first that answers. */
export async function reach(typed: string, ms = 6000): Promise<Reached> {
  const tries = candidates(typed);
  if (tries.length === 0) {
    return { ok: false, why: "not-firetower", detail: "nothing typed" };
  }

  let last: Reached = { ok: false, why: "unreachable", detail: "nothing tried" };
  for (const url of tries) {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), ms);
    try {
      const answer = await ask(url, stop.signal);
      if (answer.ok) return answer;
      last = answer;
      // A wrong scheme is worth retrying; a wrong server is not, and neither
      // is one that answered and would not talk to the app.
      if (answer.why !== "unreachable") return answer;
    } finally {
      clearTimeout(timer);
    }
  }
  return last;
}

/** Signs in with a password, against the endpoint that already exists. */
export async function signIn(
  url: string,
  username: string,
  password: string,
): Promise<
  | { ok: true; token: string; user: string; mustChangePassword: boolean }
  | { ok: false; why: string }
> {
  let res: Response;
  try {
    res = await fetch(`${url}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
  } catch (e) {
    return { ok: false, why: String((e as Error)?.message ?? e) };
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    return { ok: false, why: body?.message ?? `signing in failed (${res.status})` };
  }
  const token = body?.token ?? body?.session?.token;
  if (!token) return { ok: false, why: "no token came back" };

  // Carried out of here rather than asked for again. The password that was
  // just accepted may be a temporary one, and the gate on the server refuses
  // everything but four paths until it is replaced — so a client that threw
  // this away would sign somebody in and then show them a broken app.
  return {
    ok: true,
    token,
    user: body?.user?.username ?? username,
    mustChangePassword: !!body?.user?.mustChangePassword,
  };
}
