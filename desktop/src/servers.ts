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

/**
 * The server whose token the OS keychain would not take, if nobody has been
 * told yet.
 *
 * **There is no fallback and there must not be one.** A credential in
 * `localStorage`, in IndexedDB, in a file beside the app, or encrypted under a
 * key stored next to it, is a credential anything running as this user can
 * read: WebKitGTK writes `localStorage` at `0644` under `0755` directories,
 * and a second process under the same uid read a token straight out of it. So
 * a refused write leaves the token in `tokens` and nowhere else — the session
 * works, and does not survive the window closing.
 *
 * Which is why somebody has to be told at the moment it happens, while they
 * are still holding the password. By the next launch we no longer know whether
 * the keyring broke or the entry simply was not there, and the harm has
 * already happened.
 *
 * **Not a Linux state.** A locked keychain on macOS and a Credential Manager
 * a policy has closed on Windows arrive here too, silently, today. Linux is
 * only where it happens most: a minimal desktop, a tiling window manager and
 * anything reached over ssh frequently have no Secret Service on the bus at
 * all.
 */
let owed: string | null = null;
const unkeptWatchers = new Set<() => void>();

/** Which sign-in could not be kept and has not been admitted to yet. */
export function unkeptSignIn(): string | null {
  return owed;
}

/** Said. The next refused write asks again. */
export function unkeptSaid() {
  owed = null;
  unkeptChanged();
}

export function onUnkept(fn: () => void) {
  unkeptWatchers.add(fn);
  return () => void unkeptWatchers.delete(fn);
}

function unkeptChanged() {
  unkeptWatchers.forEach((w) => w());
}

/**
 * Put a token where the OS keeps secrets, and own up when it will not go.
 *
 * Every path that holds a token goes through here — a first sign-in, a
 * replaced password, and the one-time move of a token out of an old build's
 * registry file — because the failure is the same on all three and it was only
 * ever handled on none of them.
 */
function keep(serverId: string, token: string): Promise<void> {
  const kc = keychain();
  if (!kc) return Promise.resolve();
  /* In memory first and unconditionally: the session works whether or not the
     write below does. */
  tokens.set(serverId, token);
  return kc.set(serverId, token).catch(() => {
    owed = serverId;
    unkeptChanged();
  });
}

/** Read the keychain before anything draws. A no-op in a browser tab. */
export async function hydrate() {
  const kc = keychain();
  if (!kc) return;
  for (const s of rows()) {
    const held = await kc.get(s.serverId).catch(() => null);
    if (held) tokens.set(s.serverId, held);
    // Made by a build that kept the token in the file: move it once.
    else if (s.token) await keep(s.serverId, s.token);
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
  void keep(server.serverId, server.token);
  write([...rest, server]);
}

/** A changed password answers with a new token; keep it, drop the old. */
export function updateToken(serverId: string, token: string) {
  void keep(serverId, token);
  write(rows().map((s) => (s.serverId === serverId ? { ...s, token } : s)));
}

/**
 * The token this Mac holds for a server is no longer good.
 *
 * Kept, not forgotten: the address is still right and the organisation is
 * still whose it is — the only thing that died is the credential. Forgetting
 * would make somebody type an address they never got wrong, and on a Mac that
 * knows several servers it would quietly lose one of them.
 *
 * Happens without anybody here doing anything: a password replaced in a
 * browser ends every other session, an administrator can reset one, another
 * device can sign out, a session can simply expire. So this is reached from
 * the one place that sees every refusal rather than from a button.
 */
export function signedOut(serverId: string) {
  // `servers()`, not `rows()`: in the native shell the file never holds a
  // token and the real one is in memory from the keychain, so reading the file
  // would say "already signed out" every time and this would never fire.
  if (!servers().find((s) => s.serverId === serverId)?.token) return;

  const kc = keychain();
  if (kc) {
    tokens.delete(serverId);
    void kc.delete(serverId).catch(() => {});
  }
  write(rows().map((s) => (s.serverId === serverId ? { ...s, token: "" } : s)));
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
