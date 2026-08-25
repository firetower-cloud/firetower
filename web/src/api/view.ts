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
  /** Minutes since it started — derived, never stored. */
  minutes: number;
  /** The host's display name, looked up from its id. */
  host: string;
};

export function toView(session: Session, hosts: Host[] = []): SessionView {
  return {
    ...session,
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

/**
 * Whether a session is still going — anything that isn't over, one way or the
 * other. A screen watching one of these has a reason to keep looking.
 */
export const unfinished = (s: { status: SessionStatus }) =>
  s.status !== "Ended" && s.status !== "Failed";

/**
 * Whether you can still say something to it.
 *
 * A different question from [`unfinished`], and they disagree about exactly one
 * state. `Failed` is a *resting* state: the control plane has always allowed
 * `Failed -> Working` — "you replied, or asked for something else, back to
 * work" — and the API refuses only `Ended`. The interface was the only part
 * that treated a failure as the end, which turned one bad turn into a session
 * nobody could rescue, and a stop you asked for into the same thing.
 *
 * Only `Ended` is the end. Its workspace is gone; there is nothing left to say
 * anything to.
 */
export const answerable = (s: { status: SessionStatus }) => s.status !== "Ended";

/**
 * Whether a session still holds something on its host — a worktree, a tmux
 * session, an agent process. The same line, drawn for a different reason:
 * `Failed` holds nothing, which is why it doesn't stand in the way of removing
 * a host. The control plane draws it in the same place; if these two disagree,
 * a screen says a host is busy while the API says it's idle.
 */
export const holdsHost = unfinished;

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
    case "HandedBack": {
      // Only what is actually known here. This used to read "Pushed <branch> ·
      // ready for review" for every handed-back session — nothing pushes on
      // hand-back, and a session whose agent only said hello had neither a push
      // nor anything to review. A pull request, when there is one, is a fact.
      // The branch is not in this string: the card prints it in mono right
      // beside it, which is why the old line showed it twice.
      const open = session.checkouts?.some((c) => c.pullRequest) ?? false;
      return open ? "Pull request open" : "Handed it back";
    }
    case "Failed":
      return "Something went wrong — open the terminal";
    case "Ended":
      // It did not end so much as get taken off the inbox: its host was not
      // answering, and nothing tore the workspace down.
      return session.forgottenAt ? "Removed" : "Ended";
    default:
      return "";
  }
}
