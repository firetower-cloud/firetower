"use client";

import { Tasks } from "@/components/Tasks";

/**
 * What you could work on.
 *
 * A page rather than a panel: it is a list you scan and act on once, and it
 * does not need to be on screen while you read a conversation.
 */
export default function Page() {
  return <Tasks />;
}
