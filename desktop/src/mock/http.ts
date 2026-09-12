/**
 * The whole API surface, faked by replacing one module.
 *
 * `web/orval.config.ts` points all 86 generated operations at a single mutator,
 * `web/src/api/http.ts`. Aliasing that one file is therefore the entire mock —
 * no interceptor, no service worker, no server. The same property that makes the
 * multi-backend registry cheap to build makes this prototype cheap to build.
 *
 * What this file adds that the real one cannot: a **current backend**. The real
 * mutator reads one base URL and one token from module scope, which is exactly
 * the thing that has to change for N servers, so the prototype is built on the
 * shape we would actually ship — a backend in context, one QueryClient each.
 */
import { BACKENDS, STATE, backend, type BackendId } from "./backends";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Which server this request is for.
 *
 * Set around a fetch by the per-backend query client rather than read from a
 * global, because two backends' requests are in flight at the same time and the
 * answer differs per request.
 */
let current: BackendId = "e1";
export function usingBackend<T>(id: BackendId, fn: () => T): T {
  const before = current;
  current = id;
  try {
    return fn();
  } finally {
    current = before;
  }
}
export const currentBackend = () => current;

export function apiBase(): string {
  return backend(current).url;
}
export function wsBase(): string {
  return apiBase().replace(/^http/, "ws");
}
export function token(): string | null {
  return `tok_${current}`;
}
export function rememberToken(_: string) {}
export function forgetToken() {}
export function meansSignedOut(code: string) {
  return code === "Unauthorized";
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reads as a real network: variable, and occasionally not there at all. */
async function latency(id: BackendId) {
  const b = backend(id);
  if (b.reach === "unreachable") {
    await wait(600);
    throw new ApiError("Unreachable", `cannot reach ${b.org}`, 0);
  }
  const [lo, hi] = b.latency;
  const base = lo + Math.random() * (hi - lo);
  await wait(b.reach === "slow" ? base * 6 : base);
}

function route(id: BackendId, url: string): unknown {
  const b = backend(id);
  const path = url.split("?")[0];

  if (path === "/api/v1/bootstrap") {
    // Widened the way the memo proposes: the fields a client needs before it
    // has a token. `serverId` is the installation's org id, which already
    // exists and already survives the URL changing.
    return {
      version: "0.32.2",
      eventsPath: "/api/v1/events",
      serverId: `org_${id}`,
      orgName: b.org,
      authModes: ["password", "device"],
      capabilities: ["sessions", "terminal", "diff", "forwards"],
    };
  }
  if (path === "/api/v1/auth/me") {
    return { id: `u_${id}`, username: b.user, role: "admin", mustChangePassword: false };
  }
  if (path === "/api/v1/sessions") return STATE[id];
  if (path.startsWith("/api/v1/sessions/")) {
    const sid = path.split("/")[4];
    return STATE[id].find((s) => s.id === sid) ?? null;
  }
  if (path === "/api/v1/hosts") {
    return [{ id: `h_${id}`, name: id === "me" ? "hetzner" : `${b.org.toLowerCase()}-1`, compute: "Ssh", state: "Ready" }];
  }
  if (path === "/api/v1/agents") {
    return [
      { kind: "ClaudeCode", label: "Claude Code", configured: true },
      { kind: "Codex", label: "Codex", configured: true },
    ];
  }
  if (path === "/api/v1/repos") {
    return [...new Set(STATE[id].map((s) => s.repo))].filter(Boolean).map((slug, i) => ({
      id: `r_${id}_${i}`,
      slug,
      remote: `git@github.com:${slug}.git`,
      defaultBranch: "main",
    }));
  }
  if (path === "/api/v1/updates") return { available: false, current: "0.32.2" };
  if (path === "/api/v1/tasks") return [];
  if (path === "/api/v1/trackers") return [];
  if (path === "/api/v1/secrets") return [];
  if (path === "/api/v1/setup") return { needed: false, named: true, organization: b.org };

  return [];
}

/** Called by every generated operation as `http(url, init)`. */
export const http = async <T>(url: string, init: RequestInit = {}): Promise<T> => {
  const id = current;
  await latency(id);

  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET") {
    // Writes are acknowledged and not modelled. The prototype is about what the
    // client looks like while work is happening, not about running the work.
    return undefined as T;
  }
  return route(id, url) as T;
};

export const ALL: BackendId[] = BACKENDS.map((b) => b.id);
