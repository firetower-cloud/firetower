/**
 * Every server's sessions, for the screens that read across all of them.
 *
 * The fleet view, the palette, the strip's counts and the dock badge are the
 * only things that look at more than one server at once, and they are outside
 * any one server's provider — so they cannot use that server's cache. This is
 * the deliberate fan-out the design called for: fixtures come from `STATE`,
 * connected servers are asked directly with their own token, and the answer
 * is merged here rather than in a cache that has no server dimension.
 *
 * Polled, not streamed, and that is acceptable *here* and nowhere else: the
 * merged inbox is a glance, and each server's own screen is on its stream.
 */
import { useEffect, useState } from "react";
import type { Session } from "@/src/api/generated/model";
import { NEEDS_YOU } from "@/src/api/view";
import { BACKENDS, STATE, type Backend } from "~/mock/backends";
import { useFixtures } from "~/mock/socket";
import { onServers, servers } from "~/servers";

export type Fleet = { backend: Backend; sessions: Session[]; error: string | null };

const live: Map<string, { sessions: Session[]; error: string | null }> = new Map();
const watchers = new Set<() => void>();
const changed = () => watchers.forEach((w) => w());

/** A connected server, wearing the same clothes as a fixture. */
export function asBackend(s: ReturnType<typeof servers>[number]): Backend {
  return {
    id: s.serverId as Backend["id"],
    org: s.org,
    user: s.user,
    mark: s.org.slice(0, 1).toUpperCase(),
    url: s.url,
    latency: [0, 0],
    reach: live.get(s.serverId)?.error ? "unreachable" : "live",
  };
}

async function ask(s: ReturnType<typeof servers>[number]) {
  try {
    const res = await fetch(`${s.url}/api/v1/sessions`, {
      headers: { authorization: `Bearer ${s.token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      live.set(s.serverId, { sessions: live.get(s.serverId)?.sessions ?? [], error: body?.message ?? `answered ${res.status}` });
    } else {
      live.set(s.serverId, { sessions: (await res.json()) as Session[], error: null });
    }
  } catch (e) {
    // Keep what was last known; a list that empties itself when the VPN drops
    // reads as work being lost rather than as a network that is not there.
    live.set(s.serverId, { sessions: live.get(s.serverId)?.sessions ?? [], error: String((e as Error)?.message ?? e) });
  }
  changed();
}

let ticking: ReturnType<typeof setInterval> | undefined;
function ensureTicking() {
  if (ticking) return;
  const sweep = () => servers().forEach(ask);
  sweep();
  ticking = setInterval(sweep, 10_000);
  onServers(sweep);
}

/** All of it: fixtures, then every connected server. */
export function useFleet(): Fleet[] {
  useFixtures();
  const [, tick] = useState(0);
  useEffect(() => {
    ensureTicking();
    const w = () => tick((n) => n + 1);
    watchers.add(w);
    return () => void watchers.delete(w);
  }, []);

  return [
    ...BACKENDS.map((b) => ({ backend: b, sessions: STATE[b.id], error: null })),
    ...servers().map((s) => ({
      backend: asBackend(s),
      sessions: live.get(s.serverId)?.sessions ?? [],
      error: live.get(s.serverId)?.error ?? null,
    })),
  ];
}

/** Ember, summed over every server. What goes on the dock. */
export function waitingIn(sessions: Session[]): number {
  return sessions.filter((s) => NEEDS_YOU.includes(s.status)).length;
}
