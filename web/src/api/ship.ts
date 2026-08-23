/**
 * Where a session's work has got to on its way out.
 *
 * A session already has its own branch, so there is exactly one sequence and at
 * any moment it is at exactly one point in it:
 *
 *     changes on disk → committed → pushed → pull request open
 *
 * Knowing which is what lets one control say the next honest thing, instead of
 * offering every verb and leaving somebody to work out which applies.
 */

import type { Session, WorkSummary } from "./generated/model";

export type Stage =
  /** Nothing has changed, so there is nothing to do. */
  | "clean"
  /** Files are edited but not committed. */
  | "uncommitted"
  /** Committed, and the remote has not got it. */
  | "unpushed"
  /** Pushed, and no pull request yet. */
  | "pushed"
  /** A pull request is open. Further pushes amend it. */
  | "open";

export type Ship = {
  stage: Stage;
  /** What the button says. Always exactly what pressing it does. */
  label: string;
  /** Why it cannot be pressed, when it cannot. */
  blocked?: string;
  /** Where the pull request is, once there is one. */
  url?: string;
};

/**
 * Read the state, and say what to offer.
 *
 * `work` is absent while the summary is still being fetched, which is a
 * different thing from a clean workspace and must not be drawn as one.
 */
export function shipping(session: Session, work?: WorkSummary): Ship {
  const url = session.pullRequest ?? undefined;

  if (!session.repo) {
    return {
      stage: "clean",
      label: "Commit & push",
      blocked: "This session has no repository.",
    };
  }
  if (!work) {
    return { stage: "clean", label: "Commit & push", blocked: "Looking…", url };
  }

  if (work.uncommitted > 0) {
    return { stage: "uncommitted", label: "Commit & push", url };
  }
  if (work.ahead > 0) {
    // Committed and not sent. Amending an open request is still a push, so the
    // word is the same and the sentence around it is not.
    return { stage: url ? "open" : "unpushed", label: "Push", url };
  }
  if (!work.pushed) {
    return {
      stage: "clean",
      label: "Commit & push",
      blocked: "Nothing has changed yet.",
      url,
    };
  }
  if (url) {
    return { stage: "open", label: "View pull request", url };
  }
  return { stage: "pushed", label: "Open pull request", url };
}

/** Whether there is anything worth pressing. */
export function ready(ship: Ship): boolean {
  return ship.blocked === undefined;
}
