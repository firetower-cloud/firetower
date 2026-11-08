/**
 * One QueryClient per **identity** — a server *and the account on it* — kept
 * alive across switches, fed by its stream.
 *
 * Orval generates every query key as `[url, ...params]` with **no server
 * dimension**, so two servers answering `/api/v1/sessions` would write to the
 * same cache entry and the last to land would win. A client each avoids the
 * question, and gets the invariant for free — a server that is down cannot
 * invalidate, evict or stall anything belonging to one that is up.
 *
 * **This was keyed on `serverId` alone and that was a leak.** The reasoning
 * above is about two *servers*; two *accounts on one server* share a
 * `serverId`, so signing out and back in as somebody else reused the warm
 * client and handed the second person the first's sessions. See
 * `api/identity.ts`. The key is the identity now, in both halves — here and
 * in the held transcripts — so the original invariant holds for the case it
 * was written for and for the one it missed.
 *
 * Freshness is the event stream, not a poll. `Sessions` below follows the
 * `sessions` topic on this server's socket and folds every event into the
 * cache, so nothing here asks the control plane for anything it was just told.
 *
 * ## What a phone adds
 *
 * `refetchOnReconnect`, and a refetch when the app comes forward. A Mac is
 * disconnected rarely; a phone is disconnected constantly, and the cache is
 * staler when it comes back than any `staleTime` would guess.
 */
import { QueryClient, QueryClientProvider, focusManager, onlineManager } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { AppState, type AppStateStatus } from "react-native";
import * as Network from "expo-network";
import { applyEvent } from "~/api/events";
import { forgetConversations } from "~/api/conversation";
import { identity, useIdentityKey, type Who } from "~/api/identity";
import { SocketProvider, useSocket } from "~/api/socket";
import { useBackendId } from "~/client/http";

/* React Query's own notions of "focused" and "online" are browser events.
   Told, once, what they mean here. */
AppState.addEventListener("change", (to: AppStateStatus) => focusManager.setFocused(to === "active"));
onlineManager.setEventListener((setOnline) => {
  const sub = Network.addNetworkStateListener((state) => setOnline(!!state.isInternetReachable));
  return () => sub.remove();
});

/** Keyed on `identity(who)`, never on `serverId`. */
const clients = new Map<string, QueryClient>();

function clientFor(who: string): QueryClient {
  let c = clients.get(who);
  if (!c) {
    c = new QueryClient({
      defaultOptions: {
        queries: {
          // The stream is the source of freshness. Turned off deliberately
          // rather than by omission.
          refetchInterval: false,
          refetchOnWindowFocus: true,
          refetchOnReconnect: true,
          staleTime: 5_000,
          retry: 1,
        },
      },
    });
    clients.set(who, c);
  }
  return c;
}

const Ctx = createContext<string | null>(null);

/**
 * `server` rather than an id, because the two halves want different things:
 * the HTTP layer resolves a URL and a keychain slot from the **`serverId`**,
 * while the cache has to be partitioned by the **identity**. Passing only the
 * id made those indistinguishable, which is how the account fell out of the
 * key.
 */
export function BackendProvider({ server, children }: { server: Who; children: ReactNode }) {
  // The mutator is shared by every generated call, so it has to be told which
  // server this subtree belongs to before anything under it renders. This
  // stays the `serverId`: it answers "which address and which token", which
  // is a question about the server and not about the person.
  useBackendId(server.serverId);
  const who = identity(server);
  // Read by `conversation.ts` without importing this file — see the note in
  // `identity.ts` on why that import would break `pnpm test`.
  useIdentityKey(who);
  const client = clientFor(who);

  return (
    <Ctx.Provider value={who}>
      <QueryClientProvider client={client}>
        <SocketProvider>
          <Sessions cache={client} />
          {children}
        </SocketProvider>
      </QueryClientProvider>
    </Ctx.Provider>
  );
}

/**
 * Every session on this server, as it changes.
 *
 * One subscription for the whole app; the inbox, each workspace's header and
 * the badge all read from what this keeps fresh. Renders nothing — it exists
 * to hold a subscription for as long as the server is on screen.
 */
function Sessions({ cache }: { cache: QueryClient }) {
  const { follow } = useSocket();
  // A ref, not state: the cursor changes on every event and nothing draws it.
  const seen = useRef<number | undefined>(undefined);

  useEffect(
    () =>
      follow({
        topic: "sessions",
        cursor: () => seen.current,
        onFrame: (frame) => {
          if (frame.t !== "event") return;
          seen.current = Math.max(seen.current ?? 0, frame.event.seq);
          applyEvent(cache, frame.event);
        },
      }),
    [cache, follow],
  );

  return null;
}

export function useBackendKey(): string {
  return useContext(Ctx) ?? "";
}

/**
 * Throw away an identity's cache rather than leaving it warm.
 *
 * Takes the **identity**, not a `serverId`: signing one account out of a
 * server must not evict another account's cache on that same server, and
 * before the key carried the account it could not tell the difference.
 */
export function dropCache(who: string) {
  clients.get(who)?.clear();
  clients.delete(who);
  // Transcripts are kept outside the QueryClient — see `held` in
  // `api/conversation.ts` — so clearing one does not clear the other.
  forgetConversations(who);
}
