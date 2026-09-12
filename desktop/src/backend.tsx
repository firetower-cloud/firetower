/**
 * One QueryClient per server, kept alive across switches.
 *
 * Orval generates every query key as `[url, ...params]` with **no server
 * dimension**, so two servers answering `/api/v1/sessions` would write to the
 * same cache entry and the last to land would win. Prefixing the keys would
 * mean overriding the generator for all 86 operations; a client each avoids the
 * question, and gets the invariant for free — a server that is down cannot
 * invalidate, evict or stall anything belonging to one that is up.
 *
 * Held in a module map rather than component state, so coming back to a server
 * you already visited is instant.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useContext, type ReactNode } from "react";
import { useBackendId } from "~/mock/http";

const clients = new Map<string, QueryClient>();

function clientFor(id: string): QueryClient {
  let c = clients.get(id);
  if (!c) {
    c = new QueryClient({
      defaultOptions: {
        queries: {
          refetchOnWindowFocus: false,
          staleTime: 5_000,
          retry: 0,
          // No event stream against a real server yet, so freshness is a poll.
          // Slow on purpose: this is a stand-in for the socket, not a design.
          refetchInterval: 10_000,
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

  return (
    <Ctx.Provider value={id}>
      <QueryClientProvider client={clientFor(id)}>{children}</QueryClientProvider>
    </Ctx.Provider>
  );
}

export function useBackendKey(): string {
  return useContext(Ctx) ?? "e1";
}

/** Throw away a disconnected server's cache rather than leaving it warm. */
export function dropCache(id: string) {
  clients.get(id)?.clear();
  clients.delete(id);
}
