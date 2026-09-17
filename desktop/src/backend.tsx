/**
 * One QueryClient per server, kept alive across switches, fed by its stream.
 *
 * Orval generates every query key as `[url, ...params]` with **no server
 * dimension**, so two servers answering `/api/v1/sessions` would write to the
 * same cache entry and the last to land would win. A client each avoids the
 * question, and gets the invariant for free — a server that is down cannot
 * invalidate, evict or stall anything belonging to one that is up.
 *
 * Freshness is the event stream, not a poll. `Sessions` below follows the
 * `sessions` topic on this server's socket and folds every event into the
 * cache with the web build's own `applyEvent` — the event *is* the update, so
 * nothing here asks the control plane for anything it was just told.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { applyEvent } from "~/api/events";
import { forgetConversations } from "~/api/conversation";
import { SocketProvider, useSocket } from "~/api/socket";
import { useBackendId } from "~/client/http";

const clients = new Map<string, QueryClient>();

function clientFor(id: string): QueryClient {
  let c = clients.get(id);
  if (!c) {
    c = new QueryClient({
      defaultOptions: {
        queries: {
          // The stream is the source of freshness. Turned off deliberately
          // rather than by omission.
          refetchInterval: false,
          refetchOnWindowFocus: false,
          staleTime: 5_000,
          retry: 1,
        },
      },
    });
    clients.set(id, c);
  }
  return c;
}

const Ctx = createContext<string | null>(null);

export function BackendProvider({ id, children }: { id: string; children: ReactNode }) {
  // The mutator is shared by every generated call, so it has to be told which
  // server this subtree belongs to before anything under it renders.
  useBackendId(id);
  const client = clientFor(id);

  return (
    <Ctx.Provider value={id}>
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
 * One subscription for the whole window; the rail, the dashboard, the dock
 * badge and each workspace's header all read from what this keeps fresh.
 * Renders nothing — it exists to hold a subscription for as long as the
 * server is on screen.
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
  return useContext(Ctx) ?? "e1";
}

/** Throw away a disconnected server's cache rather than leaving it warm. */
export function dropCache(id: string) {
  clients.get(id)?.clear();
  clients.delete(id);
  // Transcripts are kept outside the QueryClient — see `held` in
  // `api/conversation.ts` — so clearing one does not clear the other.
  forgetConversations(id);
}
