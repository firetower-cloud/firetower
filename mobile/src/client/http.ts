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
 * nowhere — see {@link Aimed}, {@link aimOf} and {@link destination}.
 */
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
 * address and account included.
 *
 * `here()` itself rather than a second opinion about it: a flow that has to
 * notice its destination moving must read the same resolution the request
 * will. {@link currentBackend} answers a `serverId`, which is a third of the
 * question — the same address with somebody else signed into it is not the
 * same destination, *a different address under the same id is not either*,
 * and `forget()` moves what `here()` resolves to without `current` changing
 * at all.
 */
export const destination = (): Connected | undefined => here();

/**
 * A destination, written down: **the address as well as the id and the
 * account.**
 *
 * This is what {@link Aimed} carries, and the three fields are the whole of
 * the reason it exists. A pair of `[serverId, user]` was the first answer and
 * it bound the *identity* rather than the destination — then resolved that
 * pair against a registry the app rewrites underneath it, so the binding came
 * apart at exactly the seam it was built to close:
 *
 * `serverId` comes from the organisation's database id
 * (`crates/ft-server/src/api.rs:221`), so **it is precisely the thing a
 * database clone keeps**. `remember()` files a connection by that id and
 * replaces whatever was there (`native/servers.ts:97`), token included. So
 * staging restored from production, signed into as the same person, is the
 * same pair at a different address — and a request bound to the pair resolves
 * to the new row, and leaves for the new machine with the new machine's
 * token. The id pair was the premise of the original finding and not the
 * answer to it.
 *
 * The URL closes it because the URL is what `fetch` is actually handed. There
 * is nothing left for the registry to move that this does not notice.
 *
 * `JSON.stringify` of the triple rather than a join, for the reason
 * `api/identity.ts` sets out at length: with any separator at all, `a<SEP>b` +
 * `c` and `a` + `b<SEP>c` are one string, so one destination could be made to
 * spell another. Encoding escapes its own quoting and is unambiguous for
 * every input.
 *
 * **Separate from `identity()` on purpose.** That answers whose *cache* this
 * is, and widening it would re-key every held transcript. This answers where
 * a request goes, which is a stricter question: every aim that differs from
 * the identity is a destination that moved, and an aim is allowed to refuse
 * where a cache would only be reused.
 */
export const aimOf = (s: Connected | null | undefined): string =>
  s ? JSON.stringify([s.serverId, s.user, s.url]) : "";

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
 * **The whole destination, not the `serverId` and not the identity either.**
 * The same address with somebody else signed into it is not the server the
 * question was asked about, and neither is the same id and account at a
 * *different* address — see {@link aimOf}, which is what this field holds and
 * why it holds three things rather than two.
 *
 * `firetower?: string` and not `firetower: string | undefined` as far as any
 * caller is concerned: **the key being present is itself part of the
 * message.** See below.
 */
export type Aimed = RequestInit & { firetower?: string };

/** Called by every generated operation as `http(url, init)`. */
export const http = async <T>(url: string, init: Aimed = {}): Promise<T> => {
  const { firetower, ...rest } = init;
  /* **Asked for, rather than truthy.** A caller that names its destination
     and a caller that does not are two different requests, and `firetower:
     ""` is neither: it is what {@link aimOf} answers when there was no
     destination to write down. Read as falsy, that aim fell back to whatever
     is current — so the one input that means *I do not know where this was
     for* took the same path as *send it wherever I am*, which is the failure
     naming a destination exists to prevent, arriving through the check
     instead of around it. The key being there is the question; what is in it
     only decides which answer. */
  const aimed = "firetower" in init;
  if (aimed && !firetower) {
    throw new ApiError("NoTarget", "the Firetower this was for is not known", 0);
  }

  /* Named, or resolved. A named one that is no longer connected — signed out
     of, or moved to another address under the same id — is refused rather
     than quietly sent to whatever is current. Being pointed at the wrong
     machine is the whole of what naming it prevents. */
  const server = aimed ? servers().find((s) => aimOf(s) === firetower) : here();
  if (!server) {
    throw new ApiError(
      "NoServer",
      aimed ? "that Firetower is not connected any more" : "no Firetower is selected",
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
