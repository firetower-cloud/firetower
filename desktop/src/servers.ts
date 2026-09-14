/**
 * The servers this Mac knows about.
 *
 * The one piece of state that is genuinely the client's rather than any
 * server's. A backend is `{ url, serverId, org, user, token }` and the list of
 * them is what makes this a client for a fleet rather than a window onto one
 * box.
 *
 * The registry — address, id, organisation, user — is a small file in
 * `localStorage`. The token is not in it: in the native shell it is in the OS
 * keychain through `bridge.secrets`, read once at start-up.
 */
import { z } from "zod";
import { bridge } from "~/bridge";

export const Connected = z.object({
  /** Normalised, with no trailing slash. What we actually call. */
  url: z.string(),
  /**
   * Which Firetower this is, from `/bootstrap`.
   *
   * The token is filed under this and never under the URL: the same server on
   * a new address is still the same server, and a different server on a
   * familiar address is not — which is the case worth catching.
   */
  serverId: z.string(),
  org: z.string(),
  user: z.string(),
  token: z.string(),
  addedAt: z.string(),
});
export type Connected = z.infer<typeof Connected>;

const KEY = "firetower.servers";

/* Tokens live in the OS keychain when there is one (the native shell), and
   are held here in memory once read at start-up — the registry is read
   synchronously all over the app, and a keychain is not. In a browser tab
   they stay in the registry entry itself. */
const tokens = new Map<string, string>();
const keychain = () => bridge.secrets;

/** Read the keychain before anything draws. A no-op in a browser tab. */
export async function hydrate() {
  const kc = keychain();
  if (!kc) return;
  for (const s of rows()) {
    const held = await kc.get(s.serverId).catch(() => null);
    if (held) tokens.set(s.serverId, held);
    else if (s.token) {
      // Made by a build that kept the token in the file: move it once.
      await kc.set(s.serverId, s.token).catch(() => {});
      tokens.set(s.serverId, s.token);
    }
  }
  // The file never holds a token again.
  window.localStorage.setItem(KEY, JSON.stringify(rows().map((s) => ({ ...s, token: "" }))));
}

function rows(): Connected[] {
  try {
    const held = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
    return Connected.array().parse(held);
  } catch {
    // A shape we no longer understand is not worth keeping; signing in again
    // costs a password and guessing costs a debugging session.
    return [];
  }
}

export function servers(): Connected[] {
  const kc = keychain();
  return rows().map((s) => (kc ? { ...s, token: tokens.get(s.serverId) ?? "" } : s));
}

function write(list: Connected[]) {
  const kc = keychain();
  window.localStorage.setItem(KEY, JSON.stringify(kc ? list.map((s) => ({ ...s, token: "" })) : list));
  changed();
}

export function remember(server: Connected) {
  const rest = rows().filter((s) => s.serverId !== server.serverId);
  const kc = keychain();
  if (kc) {
    tokens.set(server.serverId, server.token);
    void kc.set(server.serverId, server.token).catch(() => {});
  }
  write([...rest, server]);
}

/** A changed password answers with a new token; keep it, drop the old. */
export function updateToken(serverId: string, token: string) {
  const kc = keychain();
  if (kc) {
    tokens.set(serverId, token);
    void kc.set(serverId, token).catch(() => {});
  }
  write(rows().map((s) => (s.serverId === serverId ? { ...s, token } : s)));
}

export function forget(serverId: string) {
  const kc = keychain();
  if (kc) {
    tokens.delete(serverId);
    void kc.delete(serverId).catch(() => {});
  }
  write(rows().filter((s) => s.serverId !== serverId));
}

const watchers = new Set<() => void>();
function changed() {
  watchers.forEach((w) => w());
}
export function onServers(fn: () => void) {
  watchers.add(fn);
  return () => void watchers.delete(fn);
}
