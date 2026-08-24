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
  /**
   * Every pull request is open, and there are commits that would amend one.
   * Pressing pushes; it opens nothing.
   */
  | "open-behind"
  /**
   * Every pull request is open and up to date. Nothing is left to do, which
   * makes this the one stage with no action attached to it.
   */
  | "open";

export type Ship = {
  stage: Stage;
  /** What the button says. Always exactly what pressing it does. */
  label: string;
  /** Why it cannot be pressed, when it cannot. */
  blocked?: string;
  /** Where to go when there is one place to go. */
  url?: string;
  /**
   * Every open pull request, so a session holding several can list them.
   *
   * `url` covers the one-repository case and is undefined as soon as there are
   * two, which used to leave the interface with a state it could name and not
   * link to.
   */
  links: PullRequestLink[];
  /** How many repositories the next step touches. */
  count: number;
};

export type PullRequestLink = { slug: string; url: string };

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
      label: "Nothing to commit",
      blocked: "This session has no repository.",
      links: [],
      count: 0,
    };
  }
  if (!work) {
    return { stage: "clean", label: OPENS, blocked: "Looking…", links: [], count: 0 };
  }

  // Every request already open, whatever stage the session as a whole is at.
  // Read once here so each branch below can hand it on: a session can be behind
  // on one repository and have a request open on another.
  const links: PullRequestLink[] = held
    .filter((c) => c.pullRequest)
    .map((c) => ({ slug: c.slug, url: c.pullRequest as string }));

  // In the order the sequence runs, because the earliest unfinished step is the
  // one to offer: committing before pushing before opening, even when another
  // repository is further along.
  const uncommitted = held.filter((c) => c.uncommitted > 0);
  if (uncommitted.length > 0) {
    return {
      stage: "uncommitted",
      label: name(OPENS, uncommitted.length, held.length),
      links,
      count: uncommitted.length,
    };
  }

  const unpushed = held.filter((c) => c.ahead > 0);
  if (unpushed.length > 0) {
    // Pushing to a branch a request is already open on amends that request
    // rather than opening a second one. Same verb, different outcome, so it is
    // a different stage — the label has to stop promising a pull request that
    // is already there.
    const amending = unpushed.every((c) => c.pullRequest);
    return amending
      ? {
          stage: "open-behind",
          label: `${name("Push", unpushed.length, held.length)} — updates the ${
            unpushed.length === 1 ? "PR" : "PRs"
          }`,
          url: single(unpushed),
          links,
          count: unpushed.length,
        }
      : {
          stage: "unpushed",
          label: name("Push & open PR", unpushed.length, held.length),
          links,
          count: unpushed.length,
        };
  }

  const pushed = held.filter((c) => c.pushed);
  // A branch with nothing on it has nothing to open a request for, and every
  // git host refuses one. `pushed` alone used to be enough to offer it, so a
  // branch that was pushed empty got a button that could only fail.
  const toOpen = pushed.filter((c) => !c.pullRequest && carries(c));
  if (toOpen.length > 0) {
    return {
      stage: "pushed",
      label: toOpen.length === 1 ? "Open pull request" : `Open ${toOpen.length} pull requests`,
      links,
      count: toOpen.length,
    };
  }

  if (links.length > 0) {
    // A statement, not a verb. Nothing here is pressable, and what draws this
    // stage renders it as a link out rather than as the primary control.
    return {
      stage: "open",
      label:
        links.length === 1 ? "Pull request open" : `${links.length} pull requests open`,
      url: single(held),
      links,
      count: links.length,
    };
  }

  // Nothing uncommitted, nothing unpushed, nothing on the branch and no
  // request open. The label says the state rather than an action, because a
  // disabled button naming a step it will not take is the thing that sent
  // somebody looking for why it would not press.
  return {
    stage: "clean",
    label: "Nothing to commit",
    blocked: held.some((c) => c.pushed)
      ? "This branch has no commits of its own, so there is nothing to open a pull request for."
      : "Nothing has changed yet.",
    links,
    count: 0,
  };
}

/**
 * Whether this checkout has anything on its branch that the base does not.
 *
 * A worker too old to answer sends nothing rather than zero, and is given the
 * benefit of the doubt: the old behaviour, rather than a button this cannot
 * justify disabling.
 */
function carries(c: CheckoutWork): boolean {
  return c.commits == null || c.commits > 0;
}

/**
 * The first step's label, which is three steps.
 *
 * One press commits, pushes and opens a pull request — so a button reading
 * "Commit & push" was describing two thirds of what it does, and the tab that
 * opened on the request came as a surprise. Abbreviated because this same
 * string is the button in the session header, where there is no room for the
 * long form; [`sequence`] carries that.
 */
const OPENS = "Commit & open PR";

/**
 * The long form, for somewhere with room to say it.
 *
 * Shown above the primary in the review sheet, so the whole sequence is written
 * out once even where the button itself is short.
 */
export function sequence(stage: Stage): string | undefined {
  switch (stage) {
    case "uncommitted":
      return "Commits the files below, pushes the branch, and opens a pull request.";
    case "unpushed":
      return "Pushes the branch and opens a pull request.";
    case "pushed":
      return "Opens a pull request for what is already pushed.";
    case "open-behind":
      return "Pushes onto the branch, which amends the pull request already open.";
    default:
      return undefined;
  }
}

/**
 * A verb, and how much of the session it applies to.
 *
 * Silent when it applies to everything: "Commit & open PR" for one repository,
 * and for two that both changed. The count is only worth saying when it is *not*
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

/**
 * Whether the work is out and nothing is left to do.
 *
 * The one stage that is a state rather than a step, and the reason it is worth
 * its own predicate: what draws it has to render something other than a button.
 */
export function done(ship: Ship): boolean {
  return ship.stage === "open";
}

/** Whether ending this would lose something. */
export function atRisk(work?: CheckoutWork[]): boolean {
  return !work || work.some((c) => c.uncommitted > 0 || c.ahead > 0);
}
