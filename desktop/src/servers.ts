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
 * Why a sign-in could not be kept, which is not always the same story.
 *
 * `signIn` is somebody holding a password they have just typed: the session
 * works, in memory, and the card offers to go on with it. `legacy` is a token
 * an older build had already written to this disk, which could not be moved
 * anywhere safe — there is no session to offer, because carrying on would mean
 * running on a credential that is readable in a `0644` file for as long as the
 * window is open. See [`endLegacy`].
 */
export type Unkept = { serverId: string; because: "signIn" | "legacy" };

/**
 * The sign-in the OS keychain would not take, if nobody has been told yet.
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
let owed: Unkept | null = null;
const unkeptWatchers = new Set<() => void>();

/** Which sign-in could not be kept and has not been admitted to yet. */
export function unkeptSignIn(): Unkept | null {
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
 * The servers somebody has signed out of here, by name and nothing else.
 *
 * **A non-secret marker, and the only thing standing between *Back* and
 * signing itself back in.** Signing out deletes the credential from the OS
 * keychain — and that delete can fail: a keyring that has gone from the bus,
 * or one that is locked, refuses it. It used to fail silently, leaving the
 * registry row in place and the old credential in the keychain, so the next
 * launch that could reach the keyring read it and signed straight back in.
 * Anybody using that desktop afterwards got the previous account back without
 * a password.
 *
 * So the name is written down *before* the delete is attempted, and
 * [`hydrate`] refuses a stored credential for any server in here. It comes off
 * for exactly one reason: a replacement credential was **successfully
 * stored**. Not when a sign-in succeeds — the whole failure above is one where
 * authenticating works and only the storing fails — and not when the delete
 * finally goes through on a later launch, except that there is then nothing
 * left to refuse, so [`hydrate`] lifts it itself.
 *
 * The row stays. The address is still right and the organisation is still
 * whose it is, so this remembers *not to use* a credential rather than
 * forgetting where it was for.
 */
const OUT_KEY = "firetower.signedOut";

function refusals(): string[] {
  try {
    const held = JSON.parse(window.localStorage.getItem(OUT_KEY) ?? "[]");
    return Array.isArray(held) ? held.filter((id): id is string => typeof id === "string") : [];
  } catch {
    /* Unreadable is the same as empty, and the next write replaces it. */
    return [];
  }
}

function keepRefusals(list: string[]) {
  try {
    window.localStorage.setItem(OUT_KEY, JSON.stringify([...new Set(list)]));
  } catch {
    /* A window told to keep nothing cannot be signed out across launches
       either — and it also keeps no credential, so there is nothing to
       restore. */
  }
}

/** Do not sign this server back in from what is stored. */
function refuse(serverId: string) {
  keepRefusals([...refusals(), serverId]);
}

/** A credential for this server has been stored. It is good again. */
function allow(serverId: string) {
  const left = refusals().filter((id) => id !== serverId);
  if (left.length !== refusals().length) keepRefusals(left);
}

function refused(serverId: string): boolean {
  return refusals().includes(serverId);
}

/**
 * How many times a server's credential has been acted on, per server.
 *
 * **Because the keychain is now read while the window is already up.**
 * `hydrate` used to finish before anything rendered, so nothing could happen
 * during it. It runs behind the first frame instead — see `main.tsx` — which
 * means a person can sign in, sign out or forget a server while a read for it
 * is still in flight, and that read must not be allowed to land on top of
 * what they did. Every path that changes a credential bumps this, and anything
 * that awaited checks it is still acting on the era it started in.
 */
const era = new Map<string, number>();
const eraOf = (serverId: string) => era.get(serverId) ?? 0;

/** Something has happened to this credential. The era it is now in. */
function moved(serverId: string): number {
  const next = eraOf(serverId) + 1;
  era.set(serverId, next);
  return next;
}

/**
 * Take a credential out of the OS keychain, and do not pretend it worked.
 *
 * `.catch(() => {})` is what made signing out a suggestion rather than a fact.
 * The answer says whether the credential is actually gone; the caller has
 * already written the refusal marker, so a `false` here means "still in there,
 * still refused, try again at the next launch" rather than "signed in".
 *
 * `at` is the era the caller is acting for. A delete that raced a sign-in
 * would take the *new* credential out, so one that has been overtaken does
 * not run at all.
 */
async function drop(serverId: string, at: number): Promise<boolean> {
  const kc = keychain();
  if (!kc) return true;
  if (eraOf(serverId) !== at) return false;
  try {
    await kc.delete(serverId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Put a token where the OS keeps secrets, and own up when it will not go.
 *
 * Every path that holds a token somebody has just authenticated with goes
 * through here — a first sign-in and a replaced password — because the failure
 * is the same on both and it was only ever handled on neither. The one-time
 * move of an older build's token is **not** one of these: see [`migrate`],
 * which must not keep a credential it could not secure.
 */
function keep(serverId: string, token: string): Promise<void> {
  const kc = keychain();
  const at = moved(serverId);
  /* In memory first and unconditionally: the session works whether or not the
     write below does. */
  tokens.set(serverId, token);
  /* A browser tab has no secure store and keeps tokens in the registry, which
     `write` has just done, so there is nothing outstanding to refuse. */
  if (!kc) {
    allow(serverId);
    return Promise.resolve();
  }
  return kc.set(serverId, token).then(
    () => {
      /* **The one thing that lifts a sign-out, and only once the credential
         is actually stored.** Clearing it on a successful *sign-in* would
         reintroduce the bug it exists for: the failure is one where
         authenticating works and the storing does not. Skipped if something
         else has happened to this credential since, because then this answer
         is about a token that is no longer the current one. */
      if (eraOf(serverId) === at) allow(serverId);
    },
    () => {
      owed = { serverId, because: "signIn" };
      unkeptChanged();
    },
  );
}

/**
 * Whether the keychain has answered yet, and whoever is waiting on it.
 *
 * Only ever false in the native shell, and only for the first moments of a
 * launch — `App` holds the body back until this is true, so that a registry
 * row whose token has not arrived is not drawn as a server you have been
 * signed out of. [`PATIENCE`] is what stops that being forever.
 */
let settled = false;
export const tokensKnown = () => settled;

function settle() {
  if (settled) return;
  settled = true;
  changed();
}

/**
 * How long the window waits for the keychain before drawing without it.
 *
 * On the three paths that work this never fires: a Secret Service read, a
 * Keychain read and a Credential Manager read all answer in single-digit
 * milliseconds. It is here for the one that does not answer at all — a
 * gnome-keyring that is installed but whose login keyring was never unlocked
 * leaves the read pending behind an `Unlock Login Keyring` prompt, and if that
 * prompt opens behind the window or is dismissed without being answered it
 * stays pending. Measured: the window painted two colours, which is to say
 * nothing, for as long as the prompt was up.
 *
 * Giving up waiting is not giving up reading. The read is left alone to
 * finish, and a token that arrives after this has fired still lands — so
 * unlocking the keyring at that point signs you in rather than needing a
 * relaunch.
 */
const PATIENCE = 2500;

/**
 * Read the keychain, behind the first frame.
 *
 * Awaited at module scope in `main.tsx` until this branch, which is what made
 * a locked keyring a window with nothing in it. It is started after the render
 * now, and three things follow from that and are handled here rather than
 * hoped about: the window has to know when this is done ([`settle`]), it has
 * to stop waiting if this never answers ([`PATIENCE`]), and **anything a
 * person does while this is in flight has to win against it** — hence the era
 * checked after every await below.
 *
 * A no-op in a browser tab, which keeps its tokens in the registry.
 */
export async function hydrate() {
  const kc = keychain();
  if (!kc) return settle();

  const stopWaiting = setTimeout(settle, PATIENCE);
  try {
    for (const s of rows()) {
      const at = eraOf(s.serverId);
      const held = await kc.get(s.serverId).catch(() => null);
      /* Signed out of, forgotten, or signed into again while that was in
         flight. The answer is about a credential that is no longer the one
         this server has, and using it would undo what somebody just did. */
      if (eraOf(s.serverId) !== at) continue;

      if (refused(s.serverId)) {
        /* Signed out of here and never signed back in. Not ours to restore —
           and now that the keychain is answering, not ours to leave in place
           either. The marker comes off only once there is nothing behind it. */
        if (!held || (await drop(s.serverId, at))) {
          if (eraOf(s.serverId) === at) allow(s.serverId);
        }
        continue;
      }

      if (held) {
        tokens.set(s.serverId, held);
        changed();
      } else if (s.token) {
        // Made by a build that kept the token in the file: move it once.
        await migrate(s, at);
      }
    }
  } finally {
    clearTimeout(stopWaiting);
    // The file never holds a token again.
    window.localStorage.setItem(KEY, JSON.stringify(rows().map((s) => ({ ...s, token: "" }))));
    settle();
    changed();
  }
}

/**
 * A token an older build wrote into the registry file, dealt with once.
 *
 * **Not [`keep`], and the difference is the whole of this function.** `keep`
 * puts the token in memory before it tries to store it, because for a sign-in
 * somebody has just authenticated and the session is theirs either way. This
 * token is different: it is already on this disk, in a world-readable file,
 * put there by a build that did not know better. If it can be moved into the
 * keychain, the registry row is blanked and nothing is lost. If it cannot,
 * going on with it would mean a live bearer token sitting in
 * `tauri_localhost_0.localstorage` for the whole session — which a security
 * review measured, and which is the one place the memory-only claim on this
 * client did not hold.
 *
 * We cannot scrub those bytes: `localStorage` is SQLite under WebKit's own
 * lock, a replaced value leaves the old page in the file until it is reused,
 * and the file is only gone for certain when the process is. What we can do is
 * make them worthless, which is [`endLegacy`].
 */
async function migrate(s: Connected, at: number) {
  const kc = keychain();
  if (!kc) return;
  try {
    await kc.set(s.serverId, s.token);
  } catch {
    if (eraOf(s.serverId) === at) await endLegacy(s);
    return;
  }
  if (eraOf(s.serverId) !== at) return;
  tokens.set(s.serverId, s.token);
  allow(s.serverId);
  changed();
}

/**
 * End a legacy sign-in this machine has nowhere safe to put.
 *
 * Revoked with its own server, so the copy an older build left in a file on
 * this disk is a dead string rather than a bearer token anything under this
 * uid can replay — and that, not a permission bit, is what actually answers
 * the exposure: the bytes are readable by this user whatever the mode is.
 *
 * Best effort, because a server behind a VPN that is off cannot be told. The
 * card still goes up, and what it says is still true either way: this machine
 * is not holding the sign-in any more.
 */
async function endLegacy(s: Connected) {
  /* Written before anything is awaited, so a read already in flight cannot
     land afterwards and sign this back in. */
  refuse(s.serverId);
  tokens.delete(s.serverId);
  owed = { serverId: s.serverId, because: "legacy" };
  unkeptChanged();
  changed();

  try {
    await fetch(`${s.url}/api/v1/auth/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${s.token}` },
    });
  } catch {
    /* Unreachable. The token stays live with the server until it expires;
       nothing more can be done about that from here. */
  }
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

  /* **The marker first, before the delete and before anything is awaited.**
     The delete can fail — a keyring that is locked or has left the bus
     refuses it — and it used to fail silently, which left the credential in
     the keychain and the registry row in place, so the next launch that could
     reach the keyring signed straight back in with it. That is the path
     *Back* on the keychain card takes when a replacement token could not be
     stored: a valid older credential is still in there, and the person who
     just said no is the one it would sign in. */
  const at = moved(serverId);
  refuse(serverId);

  const kc = keychain();
  if (kc) {
    tokens.delete(serverId);
    /* The answer is not thrown away: a refused delete leaves the credential
       in the keychain, and the marker above is what makes that safe —
       `hydrate` will not use it, and will try this again next launch. */
    void drop(serverId, at);
  }
  write(rows().map((s) => (s.serverId === serverId ? { ...s, token: "" } : s)));
}

export function forget(serverId: string) {
  const at = moved(serverId);
  const kc = keychain();
  if (kc) {
    tokens.delete(serverId);
    /* Marked as well as deleted, for the case where the delete does not go
       through: without the row there is nothing for `hydrate` to read, but
       connecting to the same Firetower again would arrive at the same
       `serverId` and find the old credential still in the keychain. */
    refuse(serverId);
    void drop(serverId, at).then((gone) => gone && allow(serverId));
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
