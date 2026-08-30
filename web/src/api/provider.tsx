"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { applyEvent } from "./events";
import { SocketProvider, useSocket } from "./socket";

/**
 * Wraps the application in a query cache and keeps it fed from the event stream.
 *
 * Because events push, queries don't need to poll: the defaults below turn off
 * interval refetching deliberately rather than by omission.
 */
export function ApiProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // The stream is the source of freshness.
            refetchInterval: false,
            refetchOnWindowFocus: false,
            staleTime: 5_000,
            retry: 1,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <SocketProvider>
        <Sessions cache={queryClient} />
        {children}
      </SocketProvider>
    </QueryClientProvider>
  );
}

/**
 * Every session of yours, as it changes.
 *
 * One subscription for the whole page, and most of the interface reads it: the
 * rail's rows and status dots, the inbox count, each tab's dot, the bring-up
 * steps and the inspector's "doing" line. They were five separate polls.
 *
 * Renders nothing. It exists to hold a subscription for as long as the page
 * does, which is a lifetime rather than a place on screen.
 */
function Sessions({ cache }: { cache: QueryClient }) {
  const { follow } = useSocket();
  // A ref, not state: the cursor changes on every event and nothing draws it,
  // so making it state would re-render the whole tree per frame.
  const seen = useRef<number | undefined>(undefined);

  useEffect(
    () =>
      follow({
        topic: "sessions",
        // Read when resubscribing rather than captured, so a reconnect resumes
        // from where this actually got to.
        cursor: () => seen.current,
        onFrame: (frame) => {
          if (frame.t !== "event") return;
          seen.current = Math.max(seen.current ?? 0, frame.event.seq);
          applyEvent(cache, frame.event);
        },
      }),
    // Followed once, for the life of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cache],
  );

  return null;
}
