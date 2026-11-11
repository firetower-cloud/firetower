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
 *
 * ---
 *
 * **One rule governs everything below, and four separate bugs came from not
 * having written it down.** A credential may be restored from the OS keychain
 * only where this file can *positively establish* that restoring it is
 * permitted. Not knowing that it is forbidden is not permission.
 *
 * Every failure on this path used to be read as permission. A keychain read
 * that errored was read as "there is no credential here". A refusal marker
 * that could not be written was read as "nothing has been signed out of". An
 * unreadable marker was read as an empty one. Each of those is the same bug —
 * something went wrong, the code took the reassuring reading, and a sign-in
 * somebody had declined came back without a password.
 *
 * So permission is a **positive assertion stored in the row it is about**:
 * `kept: true` means *the OS keychain confirmed it has this server's
 * credential*. It is written only after a keychain write has been confirmed,
 * and nothing else writes it. Which makes every other state fail closed by
 * construction, without a rule of its own:
 *
 * | what happens | what the app concludes |
 * |---|---|
 * | the registry will not parse | no servers, so no permission |
 * | a row has no `kept` at all | no permission until a read confirms one |
 * | `kept: false` | no permission; take the credential out if it is there |
 * | the keychain read fails | nothing is known, so nothing changes |
 * | the keychain write fails | `kept` stays false, so the next launch asks |
 *
 * This replaced a `firetower.signedOut` marker — a *negative* record, whose
 * absence meant permission, so losing it was a silent sign-in. [`retireMarker`]
 * honours the last one of those and removes the key.
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
  /**
   * Whether the OS keychain is **confirmed** to be holding this credential.
   *
   * The permission bit from this file's header, and the only thing that
   * authorises [`hydrate`] to sign in from what is stored. Optional because a
   * registry written by a build that predates it must still parse — a schema
   * change that emptied the registry would sign everybody out on upgrade —
   * and a row like that is adopted the first time a keychain read actually
   * answers with a credential. Until then it grants nothing.
   */
  kept: z.boolean().optional(),
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
 * Why a sign-in could not be kept, or could not be ended.
 *
 * Three different sentences, because they are three different situations and
 * one of them used to be told the others' story:
 *
 * - `signIn` — somebody is holding a password they have just typed and the
 *   keychain would not take the token. The session works, in memory, and the
 *   card offers to go on with it.
 * - `legacy` — a token an older build had already written to this disk, which
 *   could not be moved anywhere safe. There is no session to offer. `revoked`
 *   says whether the server has **confirmed** that credential is finished
 *   with, because the bytes an older build left in a world-readable file are
 *   harmless once it is and a live bearer token until it is.
 * - `signOut` — somebody signed out and this machine could neither remove the
 *   stored credential nor record the decision, so the stored sign-in may come
 *   back at the next launch and they need to hear that from us.
 */
export type Unkept =
  | { serverId: string; because: "signIn" }
  | { serverId: string; because: "legacy"; revoked: "unconfirmed" | "confirmed" }
  | { serverId: string; because: "signOut" };

/**
 * The thing that has happened and has not been admitted to yet.
 *
 * **There is no fallback store and there must not be one.** A credential in
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
 * a policy has closed on Windows arrive here too, and after the three-valued
 * read in `bridge.ts` they arrive *as themselves* rather than as an empty
 * keychain. Linux is only where it happens most: a minimal desktop, a tiling
 * window manager and anything reached over ssh frequently have no Secret
 * Service on the bus at all.
 */
let owed: Unkept | null = null;
const unkeptWatchers = new Set<() => void>();

/** Which sign-in could not be kept, or ended, and has not been said yet. */
export function unkeptSignIn(): Unkept | null {
  return owed;
}

/** Said. The next refusal asks again. */
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

function owe(next: Unkept) {
  owed = next;
  unkeptChanged();
}

/**
 * How many times a server's credential has been acted on, per server.
 *
 * **Because the keychain is read while the window is already up.** `hydrate`
 * used to finish before anything rendered, so nothing could happen during it.
 * It runs behind the first frame instead, and the body opens after
 * [`PATIENCE`] whether or not the read has answered — so a person can sign
 * in, sign out or forget a server at any point while a read for it is still
 * outstanding, and that read must not land on top of what they did. Every
 * path that changes a credential bumps this; everything that awaited checks
 * it is still acting for the era it started in.
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
 * Whether a row snapshotted earlier is still the row it was.
 *
 * Three questions, not one. The era answers "has anybody acted on this
 * credential since"; the lookup answers "is this server still in the
 * registry"; and `addedAt` answers "is this the same registration, or has it
 * been forgotten and connected to again" — which is a different sign-in under
 * the same `serverId`.
 */
function current(row: Connected, at: number): boolean {
  if (eraOf(row.serverId) !== at) return false;
  const now = rows().find((s) => s.serverId === row.serverId);
  return !!now && now.addedAt === row.addedAt;
}

/** Record that the keychain is confirmed to be holding this credential. */
function permit(serverId: string): boolean {
  return write(rows().map((s) => (s.serverId === serverId ? { ...s, kept: true } : s)));
}

/** Record that whatever is stored for this server must not be restored. */
function forbid(serverId: string): boolean {
  return write(rows().map((s) => (s.serverId === serverId ? { ...s, token: "", kept: false } : s)));
}

/**
 * Put a token where the OS keeps secrets, and own up when it will not go.
 *
 * Both paths where somebody has just authenticated — a first sign-in and a
 * replaced password — because the failure is the same on both and it was only
 * ever handled on neither. The one-time move of an older build's token is
 * **not** one of these: see [`migrate`], which must not hold a credential it
 * could not secure.
 *
 * @returns whether the keychain confirmed it. The answer is the permission
 * bit: nothing else in this file writes `kept: true`.
 */
async function keep(serverId: string, token: string): Promise<boolean> {
  const kc = keychain();
  const at = moved(serverId);
  /* In memory first and unconditionally: the session works whether or not the
     write below does. */
  tokens.set(serverId, token);
  /* A browser tab has no secure store and keeps the token in the registry,
     which `write` has already done. */
  if (!kc) return true;

  const stored = await kc.set(serverId, token);
  /* Signed out of, or forgotten, while the write was in flight. Whatever is
     in the keychain now, this is not the era that gets to say so. */
  if (eraOf(serverId) !== at) return stored.says === "done";

  if (stored.says === "done") {
    /* **The only place permission is granted, and it is granted by the
       keychain rather than by having authenticated.** Clearing it on a
       successful sign-in is the bug this shape exists to make unspellable:
       the failure that matters is one where authenticating works and the
       storing does not. */
    permit(serverId);
    return true;
  }
  owe({ serverId, because: "signIn" });
  return false;
}

/**
 * Whether the keychain has answered yet, and whoever is waiting on it.
 *
 * Only ever false in the native shell, and only for the first moments of a
 * launch — `App` holds the body back until this is true, so that a registry
 * row whose token has not arrived is not drawn as a server you have been
 * signed out of. [`PATIENCE`] is what stops that being forever.
 *
 * **It is not an ordering lock**, and nothing below may assume it is: it
 * opens on a timer while a read can still be outstanding indefinitely. That
 * is what the eras are for.
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
 * On the paths that work this never fires: a Secret Service read, a Keychain
 * read and a Credential Manager read all answer in single-digit milliseconds.
 * It is here for the one that does not answer at all — a gnome-keyring that
 * is installed but whose login keyring was never unlocked leaves the read
 * pending behind an `Unlock Login Keyring` prompt, and if that prompt opens
 * behind the window or is dismissed without being answered it stays pending.
 * Measured: the window painted two colours, which is to say nothing, for as
 * long as the prompt was up.
 *
 * Giving up waiting is not giving up reading. The read is left alone to
 * finish, and a credential that arrives after this has fired still lands.
 */
const PATIENCE = 2500;

/** How long to give a revocation before calling it unconfirmed. */
const REVOKE_PATIENCE = 10_000;

/** How often to try an unconfirmed revocation again, while this process lives. */
const REVOKE_AGAIN = 60_000;

/**
 * Read the keychain, behind the first frame.
 *
 * Awaited at module scope in `main.tsx` until recently, which is what made a
 * locked keyring a window with nothing in it. It is started after the render
 * now, and everything that follows from that is handled here rather than
 * hoped about: the window has to know when this is done ([`settle`]), it has
 * to stop waiting if this never answers ([`PATIENCE`]), and anything a person
 * does while it is in flight has to win against it.
 *
 * **Which is why the registry is snapshotted with every row's era, together,
 * before the first await.** Reading each row's era when the loop *reached* it
 * was a bug with a measured consequence: a person signed into the second
 * server while the first one was still blocking, the loop arrived at their
 * row minutes later, read the era their sign-in had already incremented,
 * found it unchanged *since that read*, and ended the session they had just
 * started.
 *
 * A no-op in a browser tab, which keeps its tokens in the registry.
 */
export async function hydrate() {
  const kc = keychain();
  if (!kc) return settle();

  /**
   * Every plaintext token an older build left in the file, taken out of it
   * **before anything is awaited**.
   *
   * A build that predates the keychain kept tokens in the registry. This
   * process must not be the reason they are still there while a keychain read
   * it cannot bound is outstanding — which is exactly what happened: the
   * registry was only blanked in this function's `finally`, so a stalled read
   * or a hanging revocation left a live bearer token in `localStorage`'s
   * logical value, past the point where the body had opened and somebody was
   * using the app.
   *
   * They are held here, in memory and nowhere else, until each has either
   * been moved into the keychain or ended.
   */
  const legacy = new Map<string, string>();
  for (const row of rows()) if (row.token) legacy.set(row.serverId, row.token);
  /* `write` strips every token in the native shell, so handing it what is
     already there is what takes them out. First, and before `retireMarker`
     below — which also writes, and would otherwise strip these before they
     had been read, leaving nothing to move into the keychain and nothing to
     revoke. */
  if (legacy.size) write(rows());

  retireMarker();

  /* Taken whole, before the first await, each row with the era it was in. */
  const snapshot = rows().map((row) => ({ row, at: eraOf(row.serverId) }));

  const stopWaiting = setTimeout(settle, PATIENCE);
  try {
    for (const { row, at } of snapshot) {
      /* Checked before the work and again after it, which is the difference
         between a guard and a decoration. */
      if (!current(row, at)) continue;
      const said = await kc.get(row.serverId);
      if (!current(row, at)) continue;

      if (row.kept === false) {
        /* Signed out of here, and nothing has been stored since. Nothing is
           restored whatever the keychain is holding — and if it is holding
           something, this is the launch that takes it out, which is the retry
           a refused deletion is owed. */
        if (said.says === "held") void kc.delete(row.serverId);
        continue;
      }

      if (said.says === "held") {
        tokens.set(row.serverId, said.token);
        /* A row from a build that did not record permission is adopted the
           first time a read actually confirms a credential. One launch, and
           then it is an ordinary row. */
        if (row.kept !== true) permit(row.serverId);
        changed();
        continue;
      }

      const old = legacy.get(row.serverId);
      if (old !== undefined) {
        /* Deliberately reached on `absent` **and** on `unknown`. Whether
           anything is stored is not the question — this is a plaintext
           credential in a world-readable file, and the only thing that
           settles what to do with it is whether the keychain will take it.
           So we ask it to, and the answer decides. */
        await migrate(row, at, old);
        continue;
      }

      if (said.says === "unknown") {
        /* **The read failed, which is not the same as nothing being there.**
           This is the line four separate failures came down to. Nothing is
           restored, nothing is forgotten, no permission is granted and none
           is taken away: the door shows for this server, and the next launch
           that can reach the keychain answers the question properly. */
        continue;
      }

      if (row.kept === true) {
        /* It said the keychain was holding one and the keychain says it is
           not — cleared by hand, or a profile copied between machines. That
           is not a credential any more, and the row should stop claiming it
           is one. */
        forbid(row.serverId);
      }
    }
  } finally {
    clearTimeout(stopWaiting);
    /* Belt as well as braces: the plaintext came out above, and this catches
       a row added by something else while this was running. `kept` survives
       the spread, so this grants and revokes nothing. */
    window.localStorage.setItem(KEY, JSON.stringify(rows().map((s) => ({ ...s, token: "" }))));
    settle();
    changed();
  }
}

/**
 * The refusal marker this file used to keep, honoured once and then removed.
 *
 * `firetower.signedOut` held the ids of servers that must not be signed back
 * into. It was the wrong shape — a record whose *absence* meant permission,
 * so every way of losing it was a silent sign-in, and there were three. Its
 * last contents still mean what they said, so they are turned into the
 * `kept: false` they should always have been, and the key goes.
 */
function retireMarker() {
  const WAS = "firetower.signedOut";
  let held: string[] | null = null;
  try {
    const raw = window.localStorage.getItem(WAS);
    if (raw === null) return;
    const parsed: unknown = JSON.parse(raw);
    held = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : null;
  } catch {
    /* Unreadable, and it is a list of refusals: the reading that signs
       somebody in is not the one to take on a guess. */
    held = null;
  }

  const out = held ?? rows().map((s) => s.serverId);
  write(rows().map((s) => (out.includes(s.serverId) ? { ...s, token: "", kept: false } : s)));
  try {
    window.localStorage.removeItem(WAS);
  } catch {
    /* It will be read again next launch and mean the same thing. */
  }
}

/**
 * A token an older build wrote into the registry file, dealt with once.
 *
 * **Not [`keep`], and the difference is the whole of this function.** `keep`
 * puts the token in memory before it tries to store it, because for a sign-in
 * somebody has just authenticated and the session is theirs either way. This
 * token is different: it was already on this disk, in a world-readable file,
 * put there by a build that did not know better. If the keychain takes it,
 * nothing is lost. If it will not, going on with it would mean a live bearer
 * token readable by anything under this uid for as long as the window is
 * open — which a security review measured, and which is the one place this
 * client's memory-only claim did not hold.
 */
async function migrate(row: Connected, at: number, token: string) {
  const kc = keychain();
  if (!kc) return;

  const stored = await kc.set(row.serverId, token);
  if (!current(row, at)) return;

  if (stored.says === "done") {
    tokens.set(row.serverId, token);
    permit(row.serverId);
    changed();
    return;
  }
  endLegacy(row, token);
}

/**
 * End a legacy sign-in this machine has nowhere safe to put.
 *
 * The row's plaintext is already gone — `hydrate` takes every one of them out
 * of the file before it awaits anything — so what is left is to stop using
 * the credential, to try to make the bytes an older build wrote worthless,
 * and to say which of those two actually happened.
 *
 * **We cannot scrub those bytes.** `localStorage` is SQLite under WebKit's own
 * lock; a replaced value leaves the old page in the file until it is reused.
 * What answers the exposure is the server being told, because a revoked token
 * is a dead string wherever its copies are. So that is what is attempted, what
 * is retried, and what is reported honestly when it has not happened — rather
 * than announced because it was tried.
 */
function endLegacy(row: Connected, token: string) {
  tokens.delete(row.serverId);
  forbid(row.serverId);
  owe({ serverId: row.serverId, because: "legacy", revoked: "unconfirmed" });
  changed();
  startRevoking(row.serverId, row.url, token);
}

/**
 * Revocations this process owes, in memory and nowhere else.
 *
 * A pending revocation holds the credential it is about, so it has to be as
 * unwritten as the credential itself. Nothing here is persisted — a token in a
 * retry queue on disk would be the fallback store this file exists to refuse —
 * which means a revocation that never lands dies with the process, and the
 * card says so rather than implying somebody is still working on it.
 */
const owedRevocations = new Map<string, { url: string; token: string }>();
let revoking: ReturnType<typeof setInterval> | undefined;

function startRevoking(serverId: string, url: string, token: string) {
  owedRevocations.set(serverId, { url, token });
  void tryRevoking(serverId);
  /* One timer for all of them, started on the first and stopped on the last. */
  revoking ??= setInterval(() => {
    for (const id of [...owedRevocations.keys()]) void tryRevoking(id);
  }, REVOKE_AGAIN);
}

async function tryRevoking(serverId: string) {
  const pending = owedRevocations.get(serverId);
  if (!pending) return;
  /* Always the credential this was opened for. A later token belongs to a
     session somebody is using. */
  if (!(await revoked(pending.url, pending.token))) return;

  owedRevocations.delete(serverId);
  if (owedRevocations.size === 0) {
    clearInterval(revoking);
    revoking = undefined;
  }
  if (owed?.serverId === serverId && owed.because === "legacy") {
    /* The card is watching this, so the sentence changes under the person
       from "it could not reach your Firetower" to "that old sign-in has been
       ended" the moment it is true. */
    owe({ ...owed, revoked: "confirmed" });
  }
}

/**
 * Tell a server one of its tokens is finished with, and find out whether it
 * listened.
 *
 * **The answer is read.** This used to `await fetch(...)` and look at nothing:
 * a 500 did not throw, an offline machine was caught and discarded, and a
 * hanging request had no deadline — so the card announced that the session had
 * been ended on every one of those, while the token still answered 200 and its
 * bytes were still in a `0644` file. Three measured rows of a table said
 * "session ended" and two of them were false.
 */
async function revoked(url: string, token: string): Promise<boolean> {
  try {
    const answer = await fetch(`${url}/api/v1/auth/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REVOKE_PATIENCE),
    });
    return answer.ok;
  } catch {
    /* Unreachable, refused, or past the deadline. Not revoked. */
    return false;
  }
}

/**
 * Which servers this process still owes a revocation it has not got.
 *
 * **No caller in the app, and that is deliberate** — the card already carries
 * the same fact, through `owed.revoked`, which is where a person needs it.
 * This exists so the retry queue is something a test can see: it is in-memory
 * state that disappears with the process, and the alternative to being able
 * to assert on it is trusting that it works.
 */
export function unconfirmedRevocations(): string[] {
  return [...owedRevocations.keys()];
}

function rows(): Connected[] {
  try {
    const held = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
    return Connected.array().parse(held);
  } catch {
    // A shape we no longer understand is not worth keeping; signing in again
    // costs a password and guessing costs a debugging session. It is also the
    // safe reading: no rows is no permission.
    return [];
  }
}

export function servers(): Connected[] {
  const kc = keychain();
  return rows().map((s) => (kc ? { ...s, token: tokens.get(s.serverId) ?? "" } : s));
}

/**
 * Write the registry, and say whether it went.
 *
 * **The answer is load-bearing.** A `setItem` that throws used to be silently
 * nothing, which on the sign-out path meant the row went on claiming the
 * keychain was holding a credential while the credential was still in there.
 * One of the two things that make a sign-out stick, and the caller has to know
 * when neither did.
 */
function write(list: Connected[]): boolean {
  const kc = keychain();
  try {
    window.localStorage.setItem(KEY, JSON.stringify(kc ? list.map((s) => ({ ...s, token: "" })) : list));
  } catch {
    return false;
  } finally {
    changed();
  }
  return true;
}

export function remember(server: Connected) {
  const rest = rows().filter((s) => s.serverId !== server.serverId);
  /* `kept: false` until the keychain says otherwise — written *before* the
     store is attempted, so the row never spends a moment claiming a
     permission nothing has granted. */
  write([...rest, { ...server, kept: false }]);
  void keep(server.serverId, server.token);
}

/** A changed password answers with a new token; keep it, drop the old. */
export function updateToken(serverId: string, token: string) {
  write(rows().map((s) => (s.serverId === serverId ? { ...s, token, kept: false } : s)));
  void keep(serverId, token);
}

/**
 * The token this Mac holds for a server is no longer good.
 *
 * Kept, not forgotten: the address is still right and the organisation is
 * still whose it is — the only thing that died is the credential. Forgetting
 * would make somebody type an address they never got wrong, and on a Mac that
 * knows several servers it would quietly lose one of them.
 *
 * Reached from the one place that sees every refusal — a password replaced in
 * a browser ends every other session, an administrator can reset one, another
 * device can sign out, a session can simply expire — and from *Back* on the
 * keychain card, which is the case that has to be airtight: there the
 * credential the person is declining may be a perfectly valid *older* one,
 * still in the keychain, and the second time they are asked for a password is
 * the moment to make sure it cannot answer for them.
 *
 * **Two independent ways for this to stick, and the person hears about it only
 * if neither did.** Taking the credential out of the keychain leaves nothing
 * to restore. Recording `kept: false` leaves nothing permitted. Either is
 * sufficient on its own; both failing is the one state we cannot make safe
 * from in here, so it is said out loud instead of assumed away.
 */
export function signedOut(serverId: string) {
  // `servers()`, not `rows()`: in the native shell the file never holds a
  // token and the real one is in memory from the keychain, so reading the file
  // would say "already signed out" every time and this would never fire.
  if (!servers().find((s) => s.serverId === serverId)?.token) return;

  const at = moved(serverId);
  tokens.delete(serverId);
  const recorded = forbid(serverId);

  const kc = keychain();
  if (!kc) {
    if (!recorded) owe({ serverId, because: "signOut" });
    return;
  }
  void kc.delete(serverId).then((gone) => {
    if (gone.says === "done") return;
    /* The credential is still in the keychain. Safe only if the row is
       recorded as not permitting it — and if the era has moved on, somebody
       has signed in again since and this is not ours to report. */
    if (!recorded && eraOf(serverId) === at) owe({ serverId, because: "signOut" });
  });
}

export function forget(serverId: string) {
  moved(serverId);
  tokens.delete(serverId);
  const kc = keychain();
  /* No marker to leave behind: the row goes, and with it the only thing that
     could have granted permission. Re-connecting to the same Firetower
     arrives at the same `serverId`, and the row it writes is `kept: false`
     until something is actually stored — so an orphan a refused deletion left
     in the keychain cannot answer for that sign-in either. */
  if (kc) void kc.delete(serverId);
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
