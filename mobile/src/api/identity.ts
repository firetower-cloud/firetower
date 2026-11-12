/**
 * Which Firetower this is: an address, a server id **and the account signed
 * into it**. One answer, used by everything that has to know.
 *
 * Everything warm in this app — the `QueryClient`, the held transcripts — used
 * to be keyed on `serverId` alone. That was a deliberate choice and the
 * reasoning behind it is still right: Orval generates every query key as
 * `[url, ...params]` with no server dimension, so two servers answering
 * `/api/v1/sessions` would write the same cache entry and the last to land
 * would win. A client each avoids the question.
 *
 * **It answered "which server" and nobody asked "which person".** Sign out of
 * a Firetower and back into the *same* Firetower as somebody else, and the
 * `serverId` is identical — so the warm client and the held transcripts were
 * reused across the account change, and the second person was handed the
 * first's conversations. So the identity gained the account.
 *
 * ## And then nobody asked "which machine"
 *
 * `serverId` comes from the organisation's **database id**
 * (`crates/ft-server/src/api.rs:221`), which makes it precisely the field a
 * restored copy keeps. `remember()` files a connection under that id and
 * replaces whatever was there, URL and token together
 * (`native/servers.ts:97`). So staging restored from production, signed into
 * as the same person, is *the same pair at a different address* — and a cache
 * keyed on the pair stayed warm while every byte underneath it started going
 * somewhere else. Nothing remounted, nothing was invalidated, and a screen
 * kept drawing one machine's workspaces over a connection to another's.
 *
 * **That is not an expensive cache miss, it is the wrong machine.** A saved
 * server whose address has moved is a different machine until something says
 * otherwise, and the sessions, transcripts and plans held against the old one
 * are another machine's. So the address is in the identity, and a URL change
 * retires the context: `BackendProvider` is keyed on this, so it remounts with
 * an empty `QueryClient` and a socket redialled at the new address, and
 * nothing is drawn or acted on until it has been read from there.
 *
 * What that costs is said plainly because it is real: **every held transcript
 * is re-keyed.** The ones under the old key become unreachable and the LRU in
 * `api/conversation.ts` reclaims them, so re-opening a conversation after a
 * URL change re-reads it the way a cold open does — the tail (`tail: 8`), with
 * the rest paged back on scroll. Not the whole conversation: history somebody
 * had already scrolled into view is fetched again rather than retained. A URL
 * only moves through `remember()`, which is a fresh `/bootstrap` and a
 * sign-in, and addresses are normalised before they reach the registry
 * (`api/probe.ts`'s `candidates`), so a trailing slash cannot spend it.
 *
 * ## Why the join is encoded rather than concatenated
 *
 * `serverId` comes from `/bootstrap`, `url` is an address somebody typed, and
 * `user` is whatever they typed at a sign-in field. Joined with *any*
 * separator, `a<SEP>b` + `c` and `a` + `b<SEP>c` are the same string — so one
 * identity could be made to spell another, which is this whole defect
 * arriving by a second route.
 *
 * A NUL looks like it escapes that and does not: JSON carries an escaped NUL
 * perfectly well, so a `serverId` or a username can contain one. The first
 * version of this file used NUL and said so confidently; `identity.test.ts`
 * caught it. `JSON.stringify` of the triple is unambiguous for *every* input
 * because it escapes the quoting itself, and it stays readable in a log.
 *
 * The `SEP` constant that NUL version left behind is gone with this. Nothing
 * read it — the encoding has no separator to name — and its value was a
 * literal NUL byte, which is why every diff of this file arrived as *binary*
 * and unreadable.
 */

/**
 * The parts of a connection that decide which Firetower it is.
 *
 * The address is one of them. See above: the id survives a database restore,
 * so without the URL two machines share an identity.
 */
export type Who = { serverId: string; user: string; url: string };

/**
 * The identity of a connection.
 *
 * Stable for as long as the same person is signed into the same server at the
 * same address, and different the moment any of the three changes — which is
 * the whole contract. `client/http.ts`'s `aimOf` **is** this function: where a
 * request goes and whose cache it lands in are one question, and all three
 * rounds of this defect were the two answers coming apart.
 */
export function identity(who: Who | null | undefined): string {
  if (!who) return "";
  return JSON.stringify([who.serverId, who.user, who.url]);
}

/**
 * Does a held key belong to this identity?
 *
 * Transcripts are filed as `${identity}:${sessionId}`, so this is a prefix
 * test — and it has to be the *whole* identity, or one account's sign-out
 * would evict another's transcripts on the same server. An identity always
 * ends in the encoding's own `]`, so no identity is a prefix of another.
 */
export function belongsTo(key: string, who: string): boolean {
  return key.startsWith(`${who}:`);
}

/** A transcript's key within an identity. */
export function conversationKey(who: string, sessionId: string): string {
  return `${who}:${sessionId}`;
}

/**
 * Which identity the generated client and the transcript store belong to.
 *
 * The same shape as `currentBackend()` in `client/http.ts`, and for the same
 * reason: both are read by code that is not a hook and must not become one.
 * `BackendProvider` sets it before anything under it renders, and the provider
 * is keyed on this value — so by the time a screen reads it, it is the
 * identity that screen was mounted for.
 *
 * It lives here rather than in `backend.tsx` so that `conversation.ts` can
 * read it without importing the provider. That import would pull React Query
 * and `expo-network` into a module whose folds are tested in plain node, and
 * `pnpm test` would stop being able to load them.
 */
let active = "";

export function useIdentityKey(who: string) {
  active = who;
}

export const currentIdentity = () => active;
