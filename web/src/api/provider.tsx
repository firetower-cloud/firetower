"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { applyEvent, subscribeToEvents } from "./events";

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

  useEffect(() => subscribeToEvents((event) => applyEvent(queryClient, event)), [queryClient]);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
