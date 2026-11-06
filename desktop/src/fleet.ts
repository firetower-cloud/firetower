/**
 * Every server's sessions, for the screens that read across all of them.
 *
 * The switcher under the avatar, the palette and the dock badge are the only
 * things that look at more than one server at once, and they are outside
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
import { needsYou } from "~/api/view";
import { onServers, servers, type Connected } from "~/servers";

export type Reach = "live" | "unreachable";

/** A connected server, as the screens see it. */
export type Backend = {
  /** The `serverId` from `/bootstrap`. */
  id: string;
  org: string;
  user: string;
  /** The monogram under the avatar. Identity is a shape here, never a hue. */
  mark: string;
  url: string;
  reach: Reach;
};

export type Fleet = { backend: Backend; sessions: Session[]; error: string | null };

const known: Map<string, { sessions: Session[]; error: string | null }> = new Map();
const watchers = new Set<() => void>();
const changed = () => watchers.forEach((w) => w());

/**
 * The monogram, and why it is two letters rather than one.
 *
 * Identity here is a shape, never a hue — there are not enough distinguishable
 * hues, they collide with the signal palette, and a colour-coded server is
 * unreadable to a dichromat. Which makes the *shape* load-bearing, and one
 * letter is not enough of it: this used to be `org.slice(0, 1)`, so Acme and
 * Apex were both "A" and Northwind and Nimbus were both "N". A mark that two
 * servers share is not a mark.
 *
 * So: the first letter, then the first letter after it that nobody else in the
 * fleet has already claimed. Acme and Apex are "Ac" and "Ap" on their own
 * second letters; Northwind and Nova both want "No", so the second takes the
 * first letter of its own that is still free and becomes "Nv". The walk is
 * over the name's own letters in order, so the mark always reads as an
 * abbreviation of the thing rather than as a code.
 *
 * It holds for two Firetowers of the *same* organisation too — a staging and
 * a production Ledger come out "Le" and "Ld", both still legibly from the
 * name. The only pair that can collide is one where both names run out of
 * letters, which takes two organisations called the same two characters.
 */
export function marksOf(orgs: string[]): string[] {
  /* Letters and digits only. A leading "@" or a space would otherwise become
     half the monogram. */
  const letters = orgs.map((o) => [...o].filter((c) => /[\p{L}\p{N}]/u.test(c)));
  const marks = orgs.map(() => "");
  /* Grouped by first letter, because that is the only collision a second
     letter can resolve. Two orgs starting differently never compete. */
  const byFirst = new Map<string, number[]>();
  letters.forEach((chars, i) => {
    const head = (chars[0] ?? "?").toUpperCase();
    byFirst.set(head, [...(byFirst.get(head) ?? []), i]);
  });

  for (const [head, group] of byFirst) {
    const taken = new Set<string>();
    for (const i of group) {
      const tail = letters[i].slice(1).map((c) => c.toLowerCase());
      /* Its own second letter when that is free, else the next of its own
         letters that is — and its plain second letter if every one is taken,
         which only happens when two names share every letter in order. */
      const pick = tail.find((c) => !taken.has(c)) ?? tail[0] ?? "";
      taken.add(pick);
      marks[i] = head + pick;
    }
  }
  return marks;
}

/**
 * One server as the screens see it.
 *
 * `among` is the fleet the mark has to be unique within, which is why it is a
 * parameter rather than something this reads for itself: the de-duplication is
 * a fact about the *set*, and a function that answered it from a global would
 * give a different answer under test than in the app.
 */
export function asBackend(s: Connected, among: Connected[] = servers()): Backend {
  const orgs = among.some((x) => x.serverId === s.serverId) ? among : [...among, s];
  const mark = marksOf(orgs.map((x) => x.org))[orgs.findIndex((x) => x.serverId === s.serverId)];
  return {
    id: s.serverId,
    org: s.org,
    user: s.user,
    mark,
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

  const here = servers();
  return here.map((s) => ({
    backend: asBackend(s, here),
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
  // `needsYou` rather than the statuses: a child that handed back to its
  // lead is not waiting on you, and the dock should not say it is.
  return sessions.filter(needsYou).length;
}
