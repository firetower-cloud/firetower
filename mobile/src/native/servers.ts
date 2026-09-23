/**
 * The Firetowers this phone knows about.
 *
 * The one piece of state that is genuinely the client's rather than any
 * server's. A backend is `{ url, serverId, org, user, token }` and the list of
 * them is what makes this a client for a fleet rather than a window onto one
 * box.
 *
 * Ported from `desktop/src/servers.ts`, and the split is the same one: the
 * registry — address, id, organisation, user — is a small record; the **token
 * is never in it**. Tokens live in the Keychain on iOS and the Keystore on
 * Android, through `expo-secure-store`, read once at start-up.
 *
 * The registry is MMKV rather than AsyncStorage for one reason: `servers()` is
 * read synchronously all over the app, exactly as it is on the desktop, and
 * AsyncStorage cannot answer synchronously. Swapping it for a promise would
 * mean threading `await` through every screen that wants to know which server
 * it is on.
 */
import { createMMKV } from "react-native-mmkv";
import * as Keychain from "expo-secure-store";

export type Connected = {
  /** Normalised, with no trailing slash. What we actually call. */
  url: string;
  /**
   * Which Firetower this is, from `/bootstrap`.
   *
   * The token is filed under this and never under the URL: the same server on
   * a new address is still the same server, and a different server on a
   * familiar address is not — which is the case worth catching.
   */
  serverId: string;
  org: string;
  user: string;
  addedAt: string;
};

const store = createMMKV({ id: "firetower.servers" });
const KEY = "registry";

/* Read once at start-up and held here, because the registry is read
   synchronously and a keychain is not. */
const tokens = new Map<string, string>();

/** Keychain keys may not contain everything a serverId might. */
const slot = (serverId: string) => `token.${serverId.replace(/[^A-Za-z0-9._-]/g, "_")}`;

/**
 * The parsed registry, held.
 *
 * Not an optimisation. `servers()` is read through `useSyncExternalStore`,
 * which compares snapshots with `Object.is` — so parsing the JSON afresh on
 * every call returns a new array every time, every comparison says "changed",
 * and React re-renders until it gives up with "maximum update depth exceeded".
 * The snapshot has to be the *same reference* until something actually writes.
 */
let held: Connected[] | null = null;

function rows(): Connected[] {
  if (held) return held;
  try {
    const raw = store.getString(KEY);
    held = raw ? (JSON.parse(raw) as Connected[]) : [];
  } catch {
    // A shape we no longer understand is not worth keeping; signing in again
    // costs a password and guessing costs a debugging session.
    held = [];
  }
  return held;
}

/** Read the keychain before anything draws. */
export async function hydrate() {
  for (const s of rows()) {
    const held = await Keychain.getItemAsync(slot(s.serverId)).catch(() => null);
    if (held) tokens.set(s.serverId, held);
  }
}

export const servers = (): Connected[] => rows();
export const tokenFor = (serverId: string) => tokens.get(serverId) ?? "";

const watchers = new Set<() => void>();
const changed = () => watchers.forEach((w) => w());
export function onServers(fn: () => void) {
  watchers.add(fn);
  return () => void watchers.delete(fn);
}

function write(list: Connected[]) {
  store.set(KEY, JSON.stringify(list));
  held = list;
  changed();
}

export function remember(server: Connected, token: string) {
  tokens.set(server.serverId, token);
  void Keychain.setItemAsync(slot(server.serverId), token).catch(() => {});
  write([...rows().filter((s) => s.serverId !== server.serverId), server]);
}

/** A changed password answers with a new token; keep it, drop the old. */
export function updateToken(serverId: string, token: string) {
  tokens.set(serverId, token);
  void Keychain.setItemAsync(slot(serverId), token).catch(() => {});
  changed();
}

export function forget(serverId: string) {
  tokens.delete(serverId);
  void Keychain.deleteItemAsync(slot(serverId)).catch(() => {});
  write(rows().filter((s) => s.serverId !== serverId));
}
