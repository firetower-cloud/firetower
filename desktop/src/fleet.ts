/**
 * Every server's sessions, for the screens that read across all of them.
 *
 * The fleet view, the palette, the strip's counts and the dock badge are the
 * only things that look at more than one server at once, and they are outside
 * any one server's provider — so they cannot use that server's cache. This is
 * the deliberate fan-out the design called for: each connected server is asked
 * directly with its own token, and the answers are merged here rather than in
 * a cache that has no server dimension.
 *
 * Polled on a slow tick, and stirred by the stream. The sweep is the floor —
 * it catches servers with no socket, reconnects, and anything the stream did
 * not carry — but a ten-second floor is the whole of the lag between the rail
 * and the island. They are drawn in the same window from different sources:
 * the rail reads a cache that `applyEvent` keeps fresh frame by frame, while
 * the island is drawn from this, and so changed colour up to ten seconds
 * after the row behind it did. `stirFleet` closes that gap.
 */
import { useEffect, useState } from "react";
import type { Session } from "~/api/generated/model";
import { NEEDS_YOU } from "~/api/view";
import { onServers, servers, type Connected } from "~/servers";

export type Reach = "live" | "unreachable";

/** A connected server, as the screens see it. */
export type Backend = {
  /** The `serverId` from `/bootstrap`. */
  id: string;
  org: string;
  user: string;
  /** The monogram in the strip. Identity is a shape here, never a hue. */
  mark: string;
  url: string;
  reach: Reach;
};

export type Fleet = { backend: Backend; sessions: Session[]; error: string | null };

const known: Map<string, { sessions: Session[]; error: string | null }> = new Map();
const watchers = new Set<() => void>();
const changed = () => watchers.forEach((w) => w());

export function asBackend(s: Connected): Backend {
  return {
    id: s.serverId,
    org: s.org,
    user: s.user,
    mark: s.org.slice(0, 1).toUpperCase(),
    url: s.url,
    reach: known.get(s.serverId)?.error ? "unreachable" : "live",
  };
}

async function ask(s: Connected) {
  try {
    const res = await fetch(`${s.url}/api/v1/sessions`, { headers: { authorization: `Bearer ${s.token}` } });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      known.set(s.serverId, { sessions: known.get(s.serverId)?.sessions ?? [], error: body?.message ?? `answered ${res.status}` });
    } else {
      known.set(s.serverId, { sessions: (await res.json()) as Session[], error: null });
    }
  } catch (e) {
    // Keep what was last known; a list that empties itself when the VPN drops
    // reads as work being lost rather than as a network that is not there.
    known.set(s.serverId, { sessions: known.get(s.serverId)?.sessions ?? [], error: String((e as Error)?.message ?? e) });
  }
  changed();
}

/**
 * Ask one server now, because its stream said something worth asking about.
 *
 * Called from the socket, which knows a status changed before any sweep
 * would. It re-reads that one server rather than patching the event into the
 * held list: the list is what the screens render, an event is a fact about
 * one session, and reconciling the two here would be a second, worse copy of
 * `applyEvent`. One request against a server that just spoke is cheap.
 *
 * Throttled on the leading edge: the first event is answered immediately,
 * which is the point, and the rest of a burst collapses into at most one more
 * sweep when the window closes. A session finishing emits several events in
 * quick succession and they all say the same thing about the fleet.
 */
const cooling = new Set<string>();
const again = new Set<string>();

export function stirFleet(serverId: string): void {
  if (cooling.has(serverId)) {
    again.add(serverId);
    return;
  }
  cooling.add(serverId);

  const now = servers().find((s) => s.serverId === serverId);
  if (now) void ask(now);

  setTimeout(() => {
    cooling.delete(serverId);
    if (again.delete(serverId)) stirFleet(serverId);
  }, 400);
}

let ticking: ReturnType<typeof setInterval> | undefined;
function ensureTicking() {
  if (ticking) return;
  const sweep = () => servers().forEach(ask);
  sweep();
  ticking = setInterval(sweep, 10_000);
  onServers(sweep);
}

/** Every connected server, with what it last said. */
export function useFleet(): Fleet[] {
  const [, tick] = useState(0);
  useEffect(() => {
    ensureTicking();
    const w = () => tick((n) => n + 1);
    watchers.add(w);
    return () => void watchers.delete(w);
  }, []);

  return servers().map((s) => ({
    backend: asBackend(s),
    sessions: known.get(s.serverId)?.sessions ?? [],
    error: known.get(s.serverId)?.error ?? null,
  }));
}

/** Forget what a server said, once it is gone from this Mac. */
export function dropFleet(serverId: string) {
  known.delete(serverId);
  changed();
}

/** Ember, summed over every server. What goes on the dock. */
export function waitingIn(sessions: Session[]): number {
  return sessions.filter((s) => NEEDS_YOU.includes(s.status)).length;
}
