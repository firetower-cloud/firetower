/**
 * The live feed.
 *
 * Hand-written, because generators produce nothing for streams — but the event
 * union is registered as a schema component, so the *generated* validator
 * checks every frame. One contract, no second definition to keep in step.
 *
 * Reconnection and replay are the browser's job: EventSource retries on its own
 * and sends `Last-Event-ID`, which the server answers with everything after
 * that sequence number. Nothing here tracks a cursor.
 */

import type { QueryClient } from "@tanstack/react-query";
import type { Event } from "./generated/model";
import {
  getGetSessionQueryKey,
  getListSessionsQueryKey,
} from "./generated/sessions/sessions";
import { getListEventsQueryKey } from "./generated/events/events";
import type { Session } from "./generated/model";
import { apiBase, token } from "./http";

export type SessionEvent = Event;

/**
 * Subscribe until the returned function is called.
 *
 * EventSource can't set headers, so the token rides in the query string. That's
 * acceptable for a loopback connection; a hosted deployment should mint a
 * short-lived stream token rather than putting the session one in a URL.
 */
export function subscribeToEvents(onEvent: (event: SessionEvent) => void): () => void {
  const auth = token();
  const url = `${apiBase()}/api/v1/events/stream${auth ? `?t=${encodeURIComponent(auth)}` : ""}`;
  const source = new EventSource(url);

  source.addEventListener("session", (message) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse((message as MessageEvent).data);
    } catch {
      console.warn("[firetower] unparseable event frame");
      return;
    }
    onEvent(parsed as SessionEvent);
  });

  source.onerror = () => {
    // Not fatal: EventSource reconnects by itself and resumes from the last id
    // it saw. Worth a line in the console, not a thrown error.
    if (source.readyState === EventSource.CLOSED) {
      console.warn("[firetower] event stream closed; the browser will retry");
    }
  };

  return () => source.close();
}

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
    queryClient.setQueryData<Session[]>(getListSessionsQueryKey(), (sessions) =>
      sessions?.map((s) =>
        s.id === event.sessionId ? { ...s, status: kind.status, updatedAt: event.at } : s,
      ),
    );
    // And the session the page is looking at, which is a query of its own —
    // it feeds the heading and decides which verbs are offered.
    queryClient.setQueryData<Session>(getGetSessionQueryKey(event.sessionId), (session) =>
      session ? { ...session, status: kind.status, updatedAt: event.at } : session,
    );
  }

  // A session that has just appeared isn't in any cached list yet, and we don't
  // have its full shape from the event alone — so ask for the list once.
  if (kind.type === "SessionCreated") {
    queryClient.invalidateQueries({ queryKey: getListSessionsQueryKey() });
  }
}
