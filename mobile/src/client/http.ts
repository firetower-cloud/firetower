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
 *
 * Reading it from module state is also the one thing a long operation cannot
 * rely on, so a request may name the Firetower it is for and go there or
 * nowhere — see {@link Aimed} and {@link destination}.
 */
import { identity } from "~/api/identity";
import { servers, tokenFor, type Connected } from "~/native/servers";

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

/**
 * Which Firetower a request sent **right now** would reach — the whole of it,
 * account included.
 *
 * `here()` itself rather than a second opinion about it: a flow that has to
 * notice its destination moving must read the same resolution the request
 * will. {@link currentBackend} answers a `serverId`, which is half of the
 * question twice over — the same address with somebody else signed into it is
 * not the same destination, and `forget()` moves what `here()` resolves to
 * without `current` changing at all.
 */
export const destination = (): Connected | undefined => here();

export const apiBase = () => here()?.url ?? "";
export const wsBase = () => apiBase().replace(/^http/, "ws");
export const token = () => {
  const s = here();
  return s ? tokenFor(s.serverId) : "";
};
export const meansSignedOut = (code: string) => code === "Unauthorized";

/**
 * A request, and optionally the Firetower it is **for**.
 *
 * `here()` reads module state the app changes underneath it: switch server and
 * everything sent afterwards goes somewhere else. That is right for a screen
 * reading data — it is the screen you are on — and wrong for a sequence that
 * has already asked a person a question about one particular place. Read the
 * workspace on one Firetower, ask, and the answer can arrive pointed at
 * another: same operation, different machine.
 *
 * So a request may name its destination and then it goes there or nowhere.
 * `ui/end.ts` is the one call in this app that cannot be taken back and is
 * the reason this exists.
 *
 * **The identity, not the `serverId`.** The same address with somebody else
 * signed into it is not the server the question was asked about — which is
 * why this reaches into `api/identity` for the one function that encodes the
 * pair. That module imports nothing, so the direction of the dependency is
 * the only thing it costs.
 */
export type Aimed = RequestInit & { firetower?: string };

/** Called by every generated operation as `http(url, init)`. */
export const http = async <T>(url: string, init: Aimed = {}): Promise<T> => {
  const { firetower, ...rest } = init;
  /* Named, or resolved. A named one that is no longer connected is refused
     rather than quietly sent to whatever is current — being pointed at the
     wrong machine is the whole of what naming it prevents. */
  const server = firetower ? servers().find((s) => identity(s) === firetower) : here();
  if (!server) {
    throw new ApiError(
      "NoServer",
      firetower ? "that Firetower is not connected any more" : "no Firetower is selected",
      0,
    );
  }

  const headers = new Headers(rest.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  headers.set("authorization", `Bearer ${tokenFor(server.serverId)}`);

  const res = await fetch(`${server.url}${url}`, { ...rest, headers });
  if (!res.ok) throw await ApiError.from(res);
  if (res.status === 204 || res.headers.get("content-length") === "0") return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
};
