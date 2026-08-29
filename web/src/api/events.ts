/**
 * Folding the live feed into the query cache.
 *
 * The frames arrive on the page's one socket — see `socket.tsx` for why there
 * is exactly one — and land here, where they update what is already held rather
 * than prompting a refetch of it. The event *is* the update.
 *
 * Which is what lets the queries below have interval refetching turned off.
 * Before the socket they polled, several of them per open tab, and that polling
 * competed for the same six connections the streams were exhausting.
 */

import type { QueryClient } from "@tanstack/react-query";
import type { Event } from "./generated/model";
import {
  getGetSessionQueryKey,
  getListSessionsQueryKey,
} from "./generated/sessions/sessions";
import { getListEventsQueryKey } from "./generated/events/events";
import type { Session } from "./generated/model";

export type SessionEvent = Event;

/**
 * Fold an event into the cache instead of refetching a list we already hold.
 *
 * The event *is* the update, so nothing here asks the control plane for
 * anything it was just told.
 */
export function applyEvent(queryClient: QueryClient, event: SessionEvent) {
  const kind = event.kind;

  // Every event feeds the activity list and the step checklist.
  //
  // Without this the page loads once and then never changes: the queries have
  // interval refetching turned off on the grounds that the stream keeps them
  // fresh, and the stream only kept the *sessions list* fresh. A step finishing
  // — or failing — was invisible until someone pressed reload.
  for (const query of queryClient.getQueryCache().findAll({
    queryKey: getListEventsQueryKey(),
  })) {
    // One cache entry per set of parameters: the whole feed, and one per
    // session. An event belongs to the unfiltered ones and to its own.
    const params = query.queryKey[1] as { sessionId?: string } | undefined;
    if (params?.sessionId && params.sessionId !== event.sessionId) continue;

    queryClient.setQueryData<SessionEvent[]>(query.queryKey, (held) => {
      if (!held) return held;
      // The stream replays from the last id it saw after a reconnect, so the
      // same event can arrive twice.
      if (held.some((e) => e.seq === event.seq)) return held;
      return [...held, event];
    });
  }

  if (kind.type === "StatusChanged") {
    // The note travels with the status and replaces whatever was there,
    // including with nothing. It is why the session stopped — the permission it
    // wants, the error that ended the turn — and a card that turns orange
    // without saying why costs a click to understand. Dropping it here left
    // exactly that, until somebody reloaded.
    const changed = { status: kind.status, note: kind.note, updatedAt: event.at };

    queryClient.setQueryData<Session[]>(getListSessionsQueryKey(), (sessions) =>
      sessions?.map((s) => (s.id === event.sessionId ? { ...s, ...changed } : s)),
    );
    // And the session the page is looking at, which is a query of its own —
    // it feeds the heading and decides which verbs are offered.
    queryClient.setQueryData<Session>(getGetSessionQueryKey(event.sessionId), (session) =>
      session ? { ...session, ...changed } : session,
    );
  }

  // A session that has just appeared isn't in any cached list yet, and we don't
  // have its full shape from the event alone — so ask for the list once.
  if (kind.type === "SessionCreated") {
    queryClient.invalidateQueries({ queryKey: getListSessionsQueryKey() });
  }
}
