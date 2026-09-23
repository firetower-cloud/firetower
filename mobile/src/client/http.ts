/**
 * The generated client's one mutator, for a phone that talks to several
 * servers.
 *
 * `orval.config.ts` points every generated operation at a single `http`, so
 * this one file is where "which Firetower am I talking to" lives. The
 * generated code never learns there is more than one.
 *
 * The token is read from the registry rather than passed in, for the same
 * reason the desktop does it: every generated call would otherwise need it
 * threaded through, and a call that forgot would fail as a 401 rather than as
 * a type error.
 */
import { servers, tokenFor } from "~/native/servers";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** From a refusal, the way the other clients read one. */
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

/** The current server, or the first one if nothing has chosen yet. */
function here() {
  const all = servers();
  return all.find((s) => s.serverId === current) ?? all[0];
}

export const apiBase = () => here()?.url ?? "";
export const wsBase = () => apiBase().replace(/^http/, "ws");
export const token = () => {
  const s = here();
  return s ? tokenFor(s.serverId) : "";
};
export const meansSignedOut = (code: string) => code === "Unauthorized";

/** Called by every generated operation as `http(url, init)`. */
export const http = async <T>(url: string, init: RequestInit = {}): Promise<T> => {
  const server = here();
  if (!server) throw new ApiError("NoServer", "no Firetower is selected", 0);

  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  headers.set("authorization", `Bearer ${tokenFor(server.serverId)}`);

  const res = await fetch(`${server.url}${url}`, { ...init, headers });
  if (!res.ok) throw await ApiError.from(res);
  if (res.status === 204 || res.headers.get("content-length") === "0") return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
};
