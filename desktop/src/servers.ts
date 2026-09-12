/**
 * The servers this Mac knows about.
 *
 * The one piece of state that is genuinely the client's rather than any
 * server's. A backend is `{ url, serverId, org, user, token }` and the list of
 * them is what makes this a client for a fleet rather than a window onto one
 * box.
 *
 * Kept in `localStorage` for now. The token belongs in the Keychain and will
 * move there — `bridge.ts` is where that lands — but the shape is the same and
 * nothing above this file has to know which it was.
 */
import { z } from "zod";

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

export function servers(): Connected[] {
  try {
    const held = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
    return Connected.array().parse(held);
  } catch {
    // A shape we no longer understand is not worth keeping; signing in again
    // costs a password and guessing costs a debugging session.
    return [];
  }
}

export function remember(server: Connected) {
  const rest = servers().filter((s) => s.serverId !== server.serverId);
  window.localStorage.setItem(KEY, JSON.stringify([...rest, server]));
  changed();
}

export function forget(serverId: string) {
  window.localStorage.setItem(
    KEY,
    JSON.stringify(servers().filter((s) => s.serverId !== serverId)),
  );
  changed();
}

const watchers = new Set<() => void>();
function changed() {
  watchers.forEach((w) => w());
}
export function onServers(fn: () => void) {
  watchers.add(fn);
  return () => void watchers.delete(fn);
}
