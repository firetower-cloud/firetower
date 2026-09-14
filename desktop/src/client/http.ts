/**
 * The generated client's one mutator, for a Mac that talks to several servers.
 *
 * `web/orval.config.ts` points every generated operation at a single `http`,
 * so replacing that one file is how the desktop gets a **current backend**:
 * the web's mutator reads one base URL and one token from module scope, which
 * is exactly what has to change for N servers. Everything here is a real
 * request with the token that server minted; nothing is faked.
 */
import { servers } from "~/servers";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** From a refusal, the way the web's client reads one. */
  static async from(res: Response): Promise<ApiError> {
    try {
      const body = (await res.json()) as { code?: string; message?: string };
      return new ApiError(body.code ?? "Internal", body.message ?? res.statusText, res.status);
    } catch {
      return new ApiError("Internal", res.statusText || "request failed", res.status);
    }
  }
}

/** Which server the generated client is talking to: a `serverId` from `/bootstrap`. */
let current: string | null = null;
export function useBackendId(id: string) {
  current = id;
}
export const currentBackend = () => current;

function here() {
  return servers().find((s) => s.serverId === current);
}

export const apiBase = () => here()?.url ?? "";
export const wsBase = () => apiBase().replace(/^http/, "ws");
export const token = () => here()?.token ?? "";
/* The web keeps its token in the browser; the desktop keeps one per server in
   the registry, so these are the web's names for things the desktop does elsewhere. */
export function rememberToken(_: string) {}
export function forgetToken() {}
export const meansSignedOut = (code: string) => code === "Unauthorized";

/** Called by every generated operation as `http(url, init)`. */
export const http = async <T>(url: string, init: RequestInit = {}): Promise<T> => {
  const server = here();
  if (!server) throw new ApiError("NoServer", "no Firetower is selected", 0);

  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  headers.set("authorization", `Bearer ${server.token}`);

  const res = await fetch(`${server.url}${url}`, { ...init, headers });
  if (!res.ok) throw await ApiError.from(res);
  if (res.status === 204 || res.headers.get("content-length") === "0") return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
};
