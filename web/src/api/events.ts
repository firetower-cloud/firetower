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
import { getListSessionsQueryKey } from "./generated/sessions/sessions";
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
 * Only status changes alter a session's shape today. Everything else is
 * narration for the activity view, which reads the events themselves.
 */
export function applyEvent(queryClient: QueryClient, event: SessionEvent) {
  const kind = event.kind;

  if (kind.type === "StatusChanged") {
    queryClient.setQueryData<Session[]>(getListSessionsQueryKey(), (sessions) =>
      sessions?.map((s) =>
        s.id === event.sessionId ? { ...s, status: kind.status, updatedAt: event.at } : s,
      ),
    );
  }

  // A session that has just appeared isn't in any cached list yet, and we don't
  // have its full shape from the event alone — so ask for the list once.
  if (kind.type === "SessionCreated") {
    queryClient.invalidateQueries({ queryKey: getListSessionsQueryKey() });
  }
}
