/**
 * The whole API surface, faked by replacing one module.
 *
 * `web/orval.config.ts` points all 86 generated operations at a single mutator,
 * so aliasing that one file is the entire mock — no interceptor, no service
 * worker, no server.
 *
 * What this adds that the real mutator cannot is a **current backend**. The real
 * one reads a base URL and a token from module scope, which is exactly the thing
 * that has to change for N servers.
 */
import { BACKENDS, STATE, TASKS, backend, type BackendId } from "./backends";

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

let current: BackendId = "e1";
export function useBackendId(id: BackendId) {
  current = id;
}
export const currentBackend = () => current;

export const apiBase = () => backend(current).url;
export const wsBase = () => apiBase().replace(/^http/, "ws");
export const token = () => `tok_${current}`;
export function rememberToken(_: string) {}
export function forgetToken() {}
export const meansSignedOut = (code: string) => code === "Unauthorized";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function latency(id: BackendId) {
  const b = backend(id);
  if (b.reach === "unreachable") {
    await wait(400);
    throw new ApiError("Unreachable", `can't reach ${b.org}`, 0);
  }
  const [lo, hi] = b.latency;
  const base = lo + Math.random() * (hi - lo);
  await wait(b.reach === "slow" ? base * 6 : base);
}

function host(id: BackendId) {
  const b = backend(id);
  return {
    id: `h_${id}`,
    name: id === "me" ? "hetzner" : `${b.org.toLowerCase()}-1`,
    compute: { Ssh: { host: b.url.replace(/^https?:\/\//, ""), user: "root" } },
    state: "Online",
    docker: "Ready",
    drained: false,
    reconnecting: false,
    cpus: 8,
    memoryMb: 32768,
    machine: "aarch64-linux",
    workerVersion: "0.32.2",
    capacity: {
      memoryMb: 32768,
      memoryUsedMb: 9400,
      diskTotalMb: 460000,
      diskUsedMb: 120000,
      diskFiretowerMb: 38000,
      diskCachedImagesMb: 12000,
      diskReclaimableMb: 9000,
    },
  };
}

function agents(id: BackendId) {
  const on = (kind: string) => ({
    hostId: `h_${id}`,
    hostName: host(id).name,
    installed: true,
    loggedIn: true,
    version: "latest",
    checkedAt: new Date().toISOString(),
    coveredByToken: true,
    account: null,
  });
  return [
    { kind: "ClaudeCode", label: "Claude Code", supported: true, enabled: true, credentialSet: true, needsCredential: true, signsInWithACode: true, tokenCommand: null, mode: "Subscription", hosts: [on("ClaudeCode")] },
    { kind: "Codex", label: "Codex", supported: true, enabled: true, credentialSet: true, needsCredential: true, signsInWithACode: true, tokenCommand: null, mode: "Subscription", hosts: [on("Codex")] },
    { kind: "Shell", label: "Shell", supported: true, enabled: true, credentialSet: false, needsCredential: false, signsInWithACode: false, tokenCommand: null, mode: null, hosts: [on("Shell")] },
  ];
}

function route(id: BackendId, url: string, init: RequestInit): unknown {
  const b = backend(id);
  const [path, query] = url.split("?");
  const seg = path.split("/").filter(Boolean);

  if (path === "/api/v1/bootstrap") {
    return {
      version: "0.32.2",
      eventsPath: "/api/v1/events",
      // Widened the way the memo proposes. `serverId` is the installation's org
      // id, which already exists and already survives the URL changing.
      serverId: `org_${id}`,
      orgName: b.org,
      authModes: ["password", "device"],
    };
  }
  if (path === "/api/v1/auth/me") {
    return {
      user: { id: `u_${id}`, username: b.user, email: null, role: "admin", mustChangePassword: false, createdAt: new Date(0).toISOString() },
      organization: { id: `org_${id}`, name: b.org },
    };
  }
  if (path === "/api/v1/setup") return { organization: b.org, named: true, users: 1 };

  if (path === "/api/v1/sessions") {
    const params = new URLSearchParams(query ?? "");
    const limit = Number(params.get("limit") ?? 0);
    const all = [...STATE[id]].sort((x, y) => y.createdAt.localeCompare(x.createdAt));
    return limit ? all.slice(0, limit) : all;
  }
  if (seg[2] === "sessions" && seg[3]) {
    const s = STATE[id].find((x) => x.id === seg[3]);
    if (seg[4] === "files" || seg[4] === "find") return [];
    return s ?? null;
  }

  if (path === "/api/v1/hosts") return [host(id)];
  if (path === "/api/v1/agents") return agents(id);
  if (path === "/api/v1/tasks") return { tasks: TASKS[id], more: false, next: null, total: TASKS[id].length };
  if (path === "/api/v1/trackers") {
    return [{ id: "github", label: "GitHub", connected: true, scopes: ["repo"], auth: "Token", kind: "Repo" }];
  }
  if (path === "/api/v1/repos") {
    const slugs = [...new Set(STATE[id].map((s) => s.repo).filter(Boolean))] as string[];
    return slugs.map((slug, i) => ({
      id: `r_${id}_${i}`,
      slug,
      remote: `git@github.com:${slug}.git`,
      defaultBranch: "main",
      visibility: "org",
      addedBy: `u_${id}`,
      createdAt: new Date(0).toISOString(),
    }));
  }
  if (path === "/api/v1/secrets") return [];
  if (path === "/api/v1/forwards") return [];
  if (path === "/api/v1/annotations") return [];
  if (path === "/api/v1/events") return [];
  if (path === "/api/v1/updates") {
    return {
      current: "0.32.2",
      updateAvailable: false,
      checkedAt: new Date().toISOString(),
      checkError: null,
      activeRun: null,
      latest: null,
      controlPlane: { version: "0.32.2", upgradable: false, sessions: STATE[id].length, updater: true, reason: null },
      hosts: [{ hostId: `h_${id}`, name: host(id).name, kind: "Worker", version: "0.32.2", upgradable: false, online: true, drained: false, sessions: STATE[id].length, reason: null }],
    };
  }
  if (path === "/api/v1/providers") {
    return [{ kind: "GitHub", label: "GitHub", connected: true, identity: "kevinpiac", clientIdSet: true, scopes: [] }];
  }
  if (path === "/api/v1/accounts") {
    return [{ id: `a_${id}`, kind: "ClaudeCode", name: "Default account", mode: "Subscription", isDefault: true, enabled: true, state: "connected", identity: b.user, fingerprint: null }];
  }

  return [];
}

/** Called by every generated operation as `http(url, init)`. */
export const http = async <T>(url: string, init: RequestInit = {}): Promise<T> => {
  const id = current;
  await latency(id);

  const method = (init.method ?? "GET").toUpperCase();
  // Writes are acknowledged and not modelled: the prototype is about what the
  // client looks like while work happens, not about running the work.
  if (method !== "GET") return undefined as T;

  return route(id, url, init) as T;
};

export const ALL: BackendId[] = BACKENDS.map((b) => b.id);
