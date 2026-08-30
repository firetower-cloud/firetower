/**
 * Deciding what to do with a frame, apart from the socket that carries it.
 *
 * The provider in `socket.tsx` is all effect — a connection, timers, a set of
 * listeners. These are the decisions it makes, kept separate so they can be
 * checked without a browser: which listener a frame belongs to, and how long to
 * wait before re-establishing one that keeps failing.
 */

import type { ServerFrame } from "./generated/model";

/** What a subscription is about. Mirrors `Topic` in the contract. */
export type Topic = "sessions" | "conversation";

/** The identity of a subscription: two listeners on this share one. */
export function keyOf(of: { topic: Topic; id?: string }): string {
  return `${of.topic}:${of.id ?? ""}`;
}

/** Whether this frame is this listener's business. */
export function addressed(frame: ServerFrame, listener: { topic: Topic; id?: string }): boolean {
  switch (frame.t) {
    case "event":
      return listener.topic === "sessions";
    case "line":
      return listener.topic === "conversation" && frame.id === listener.id;
    case "reset":
    case "error":
      return frame.topic === listener.topic && (frame.id ?? undefined) === listener.id;
    default:
      // `ready` and `pong` are about the connection, not a subscription.
      return false;
  }
}

/** How close together two resets have to be before they count as a run. */
const TOGETHER = 2_000;

/** Never wait longer than this to try again. */
const LONGEST = 10_000;

/**
 * How long to wait before resubscribing after a reset, and where that leaves
 * the run of them.
 *
 * A reset usually means "you fell behind, catch up", and immediately is the
 * right answer. But it also means "the thing feeding this went away" — and if
 * it cannot be re-established, resubscribing ends the same way at once. Without
 * a backoff that is a tight loop between the two ends, and the first one is the
 * common case, so it must stay immediate.
 */
export function nextResume(
  last: { at: number; run: number } | undefined,
  now: number,
): { wait: number; run: number } {
  const run = last && now - last.at < TOGETHER ? last.run + 1 : 0;
  return { wait: run === 0 ? 0 : Math.min(250 * 2 ** run, LONGEST), run };
}
