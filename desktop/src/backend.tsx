/**
 * One QueryClient per server.
 *
 * This is the part of the architecture the prototype exists to prove. Orval
 * generates every query key as `[url, ...params]` with **no server dimension**,
 * so two backends answering `/api/v1/sessions` write to the same cache entry and
 * the second one to land wins. Prefixing the keys would mean overriding the
 * generator for all 86 operations.
 *
 * A client per backend avoids the question entirely: keys never need to be
 * unique across servers because the caches are never shared. It also gets the
 * §4 invariant for free — a backend that is down cannot invalidate, evict or
 * stall anything belonging to one that is up.
 *
 * The cost is that anything reading *across* servers — the inbox, the ember
 * count — is a deliberate fan-out rather than a query, which is the right shape
 * anyway: merging N servers is a product decision, not a cache accident.
 */
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { BACKENDS, backend, STATE, type Backend, type BackendId } from "./mock/backends";
import { usingBackend } from "./mock/http";
import { useFixtures } from "./mock/socket";
import type { Session } from "@/src/api/generated/model";

const clients = new Map<BackendId, QueryClient>();

export function clientFor(id: BackendId): QueryClient {
  let c = clients.get(id);
  if (!c) {
    c = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: 5_000,
          // Every fetch runs with this backend current, which is how the shared
          // mutator knows which server it is talking to.
          queryFn: undefined,
        },
      },
    });
    clients.set(id, c);
  }
  return c;
}

const Ctx = createContext<Backend | null>(null);

/** Everything rendered inside this belongs to one server. */
export function BackendProvider({ id, children }: { id: BackendId; children: ReactNode }) {
  const b = backend(id);
  return (
    <Ctx.Provider value={b}>
      <QueryClientProvider client={clientFor(id)}>{children}</QueryClientProvider>
    </Ctx.Provider>
  );
}

export function useBackend(): Backend {
  const b = useContext(Ctx);
  if (!b) throw new Error("useBackend outside a BackendProvider");
  return b;
}

export type Row = Session & { backend: Backend };

/**
 * The inbox: every server's sessions in one list.
 *
 * Reads the fixtures directly rather than through react-query, because the whole
 * point is that this is a fan-out across N caches and not a query against one.
 * The shape is what matters here, not the plumbing.
 */
export function useInbox(): { rows: Row[]; waiting: number } {
  useFixtures();
  return useMemo(() => {
    const rows: Row[] = [];
    for (const b of BACKENDS) {
      // A server that is down keeps its rows. They go stale, they do not vanish
      // — a list that empties itself when the VPN drops reads as work being
      // lost rather than as a network that is not there.
      for (const s of STATE[b.id]) rows.push({ ...s, backend: b });
    }
    const waiting = rows.filter((r) => NEEDS_YOU.has(r.status)).length;
    return { rows, waiting };
  }, [BACKENDS.map((b) => b.reach).join(), JSON.stringify(BACKENDS.map((b) => STATE[b.id].map((s) => s.status + s.updatedAt)))]);
}

export const NEEDS_YOU = new Set(["NeedsYou", "HandedBack", "Failed"]);
export const IN_FLIGHT = new Set(["Starting", "Working"]);

export { usingBackend };
