/**
 * Where a session's work has got to on its way out.
 *
 * Each repository a session holds goes through exactly one sequence:
 *
 *     changes on disk → committed → pushed → pull request open
 *
 * A session holds any number of them, and they are rarely at the same point —
 * you change the API and the client, commit both, and one push fails. So this
 * reads every checkout and says the *next honest thing* for the session as a
 * whole, which is what lets one control name a step instead of offering every
 * verb and leaving somebody to work out which applies.
 */

import type { CheckoutWork, Session } from "./generated/model";

export type Stage =
  /** Nothing has changed anywhere, so there is nothing to do. */
  | "clean"
  /** Files are edited but not committed. */
  | "uncommitted"
  /** Committed, and a remote hasn't got it. */
  | "unpushed"
  /** Pushed, and something has no pull request yet. */
  | "pushed"
  /** Every pull request is open. Further pushes amend them. */
  | "open";

export type Ship = {
  stage: Stage;
  /** What the button says. Always exactly what pressing it does. */
  label: string;
  /** Why it cannot be pressed, when it cannot. */
  blocked?: string;
  /** Where to go when there is one place to go. */
  url?: string;
  /** How many repositories the next step touches. */
  count: number;
};

/**
 * Read the state, and say what to offer.
 *
 * `work` is absent while the summary is still being fetched, which is a
 * different thing from a clean workspace and must not be drawn as one.
 */
export function shipping(session: Session, work?: CheckoutWork[]): Ship {
  const held = work ?? [];

  if (session.checkouts?.length === 0 && !session.repo) {
    return {
      stage: "clean",
      label: "Commit & push",
      blocked: "This session has no repository.",
      count: 0,
    };
  }
  if (!work) {
    return { stage: "clean", label: "Commit & push", blocked: "Looking…", count: 0 };
  }

  // In the order the sequence runs, because the earliest unfinished step is the
  // one to offer: committing before pushing before opening, even when another
  // repository is further along.
  const uncommitted = held.filter((c) => c.uncommitted > 0);
  if (uncommitted.length > 0) {
    return { stage: "uncommitted", label: name("Commit & push", uncommitted.length, held.length), count: uncommitted.length };
  }

  const unpushed = held.filter((c) => c.ahead > 0);
  if (unpushed.length > 0) {
    // Amending an open request is still a push, so the word is the same and the
    // sentence around it is not.
    const open = unpushed.every((c) => c.pullRequest);
    return {
      stage: open ? "open" : "unpushed",
      label: name("Push", unpushed.length, held.length),
      url: single(unpushed),
      count: unpushed.length,
    };
  }

  const pushed = held.filter((c) => c.pushed);
  const toOpen = pushed.filter((c) => !c.pullRequest);
  if (toOpen.length > 0) {
    return {
      stage: "pushed",
      label: toOpen.length === 1 ? "Open pull request" : `Open ${toOpen.length} pull requests`,
      count: toOpen.length,
    };
  }

  const open = held.filter((c) => c.pullRequest);
  if (open.length > 0) {
    return {
      stage: "open",
      label: open.length === 1 ? "View pull request" : `${open.length} pull requests open`,
      url: single(open),
      count: open.length,
    };
  }

  return {
    stage: "clean",
    label: "Commit & push",
    blocked: "Nothing has changed yet.",
    count: 0,
  };
}

/**
 * A verb, and how much of the session it applies to.
 *
 * Silent when it applies to everything: "Commit & push" for one repository, and
 * for two that both changed. The count is only worth saying when it is *not*
 * all of them — that is the case somebody needs to notice.
 */
function name(verb: string, touched: number, held: number): string {
  if (held <= 1 || touched === held) return verb;
  return `${verb} ${touched} of ${held}`;
}

/** The one URL, when there is exactly one. */
function single(held: CheckoutWork[]): string | undefined {
  const urls = held.map((c) => c.pullRequest).filter(Boolean);
  return urls.length === 1 ? (urls[0] as string) : undefined;
}

/** Whether there is anything worth pressing. */
export function ready(ship: Ship): boolean {
  return ship.blocked === undefined;
}

/** Whether ending this would lose something. */
export function atRisk(work?: CheckoutWork[]): boolean {
  return !work || work.some((c) => c.uncommitted > 0 || c.ahead > 0);
}
