/**
 * The interface was designed against imagined data. This is where it meets the
 * real thing.
 *
 * Nine fields the prototype assumed don't exist on a real session. Three were
 * renames, three are derivations, two belong to the workspace rather than the
 * session, and one was a genuine gap that has since been added. Rather than
 * widening the API to keep the mock compiling, the difference is resolved here.
 */

import type { Host, Session, SessionStatus } from "./generated/model";

/** What the screens actually render. */
export type SessionView = Session & {
  /** `title` under the name the interface uses. */
  name: string;
  /** Minutes since it started — derived, never stored. */
  minutes: number;
  /** The host's display name, looked up from its id. */
  host: string;
};

export function toView(session: Session, hosts: Host[] = []): SessionView {
  return {
    ...session,
    name: session.title,
    minutes: minutesSince(session.createdAt),
    host: hosts.find((h) => h.id === session.hostId)?.name ?? "unknown",
  };
}

export function minutesSince(iso: string): number {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.round((Date.now() - then) / 60_000));
}

export function elapsed(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

/**
 * Everything waiting on a human. All three mean the same thing to the person
 * using Firetower: it stopped being useful without you.
 */
export const NEEDS_YOU: SessionStatus[] = ["NeedsYou", "HandedBack", "Failed"];
export const IN_FLIGHT: SessionStatus[] = ["Starting", "Working"];

export const needsYou = (s: { status: SessionStatus }) => NEEDS_YOU.includes(s.status);
export const inFlight = (s: { status: SessionStatus }) => IN_FLIGHT.includes(s.status);

/** What the interface calls each state. Exhaustive by construction. */
export const STATUS_LABEL: Record<SessionStatus, string> = {
  Starting: "Starting up",
  Working: "Working",
  NeedsYou: "Asked a question",
  HandedBack: "Handed it back",
  Failed: "Failed",
  Ended: "Ended",
};

/** Terminal-state summary, derived rather than stored. */
export function outcomeOf(session: Session): string {
  switch (session.status) {
    case "HandedBack":
      return `Pushed ${session.branch} · ready for review`;
    case "Failed":
      return "Something went wrong — open the terminal";
    case "Ended":
      return "Ended";
    default:
      return "";
  }
}
