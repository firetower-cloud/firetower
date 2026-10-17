/**
 * Where a session's work has got to on its way out.
 *
 * Each repository a session holds goes through exactly one sequence:
 *
 *     changes on disk → committed → pushed → request open
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
  /**
   * Nobody could find out what is in this workspace.
   *
   * The host stopped answering, or answered and could not read the checkout.
   * Deliberately not `clean`: those two used to be the same state here, so a
   * worker that had gone away was drawn as a session with nothing left to
   * commit — and somebody spent a day believing an afternoon of work was gone.
   * Nothing is offered from here, because nothing here is known.
   */
  | "unknown"
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
  | "open"
  /** Every request went in. The work is on the base branch. */
  | "merged"
  /** Every request was closed without merging. The branch is still here. */
  | "closed";

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
  /**
   * Whether pressing this creates the trunk instead of opening a pull request.
   *
   * True for the first session on a repository with no commits in it. There is
   * no trunk on the far end to open a request against, so the sequence ends at
   * the push — and the push is what creates one. Said here rather than worked
   * out again by whoever draws the button, because the step it runs has to
   * match the step it names.
   */
  seeds?: boolean;
};

export type PullRequestLink = { slug: string; url: string };

/**
 * Read the state, and say what to offer.
 *
 * `work` is absent while the summary is still being fetched, which is a
 * different thing from a clean workspace and must not be drawn as one.
 *
 * `failed` separates the third case out from those two. A request that came
 * back an error left `work` undefined, exactly like one still in flight, so the
 * interface sat on "Looking…" for as long as a host stayed unreachable and the
 * file list beside it read "Nothing has changed." Both were the same absence
 * standing in for two opposite facts.
 */
export function shipping(
  session: Session,
  work?: CheckoutWork[],
  failed?: boolean,
  /**
   * What the host this session's repository is on calls a request to merge a
   * branch. `pull request` on GitHub and Gitea, `merge request` on GitLab.
   *
   * Defaulted rather than required, because every caller that has not been
   * taught to ask yet is on GitHub by construction — and a label that says
   * "pull request" on a GitLab is wrong in a way somebody notices, while one
   * that says it on a GitHub is simply right.
   */
  noun: string = "pull request",
): Ship {
  const held = work ?? [];
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
  /* `PR` on GitHub, `MR` on GitLab. The short form is the button in the session
     header, where there is no room for the long one. */
  const SHORT = noun === "merge request" ? "MR" : "PR";
  const opens = `Commit & open ${SHORT}`;

  if (session.checkouts?.length === 0 && !session.repo) {
    return {
      stage: "clean",
      label: "Nothing to commit",
      blocked: "This session has no repository.",
      links: [],
      count: 0,
    };
  }
  if (failed && !work) {
    return {
      stage: "unknown",
      label: "Can't reach this session",
      blocked:
        "Firetower can't reach the machine this session is on, so it can't tell what has changed. Your work is still in the workspace there.",
      links: [],
      count: 0,
    };
  }
  if (!work) {
    return { stage: "clean", label: opens, blocked: "Looking…", links: [], count: 0 };
  }

  // A checkout nobody could read makes the whole session unknown rather than
  // averaging into it. Two repositories where one is unreadable is not "half
  // clean": it is a session whose state nobody can state.
  const unreadable = held.filter((c) => c.uncommitted == null);
  if (unreadable.length > 0) {
    return {
      stage: "unknown",
      label: unreadable.length === 1 ? "Can't read the workspace" : "Can't read the workspaces",
      blocked:
        unreadable
          .map((c) => c.trouble)
          .find((t): t is string => !!t) ??
        "Firetower could not read what is in this workspace.",
      links: held
        .filter((c) => c.pullRequest)
        .map((c) => ({ slug: c.slug, url: c.pullRequest as string })),
      count: unreadable.length,
    };
  }

  // Every request already open, whatever stage the session as a whole is at.
  // Read once here so each branch below can hand it on: a session can be behind
  // on one repository and have a request open on another.
  const links: PullRequestLink[] = held
    .filter((c) => c.pullRequest)
    .map((c) => ({ slug: c.slug, url: c.pullRequest as string }));

  // A repository whose trunk does not exist yet.
  //
  // Its own sequence, and a short one: commit, push, done. Every git host
  // refuses a pull request into a branch that is not there, and the push is
  // what creates it — from this session's own work, which is the whole of the
  // repository's history at that point. `unborn` is the worker's current
  // reading rather than a memory, so the moment the trunk exists this branch
  // stops being taken and the ordinary ladder below runs instead.
  //
  // `every`, not `some`: a session holding an empty repository beside a full
  // one still has a pull request to open, and one button has to name a step
  // that covers all of them.
  const trunk = trunkOf(held);
  if (held.length > 0 && held.every((c) => c.unborn === true)) {
    const dirty = held.filter((c) => (c.uncommitted ?? 0) > 0);
    if (dirty.length > 0) {
      return {
        stage: "uncommitted",
        label: name(`Commit & push ${trunk}`, dirty.length, held.length),
        links,
        count: dirty.length,
        seeds: true,
      };
    }
    // `commits` and not `ahead`: a push that created the branch and failed to
    // create the trunk — a ruleset on it, somebody else pushing one first —
    // leaves `ahead` at zero with the trunk still missing, and pressing again
    // is what tries it again.
    const carrying = held.filter((c) => (c.commits ?? 0) > 0);
    if (carrying.length > 0) {
      return {
        stage: "unpushed",
        label: name(`Push ${trunk}`, carrying.length, held.length),
        links,
        count: carrying.length,
        seeds: true,
      };
    }
    return {
      stage: "clean",
      label: "Nothing to commit",
      blocked: `Nothing has changed yet. ${trunk} does not exist in this repository, and this session's first push is what creates it.`,
      links,
      count: 0,
    };
  }

  // In the order the sequence runs, because the earliest unfinished step is the
  // one to offer: committing before pushing before opening, even when another
  // repository is further along.
  const uncommitted = held.filter((c) => (c.uncommitted ?? 0) > 0);
  if (uncommitted.length > 0) {
    return {
      stage: "uncommitted",
      label: name(opens, uncommitted.length, held.length),
      links,
      count: uncommitted.length,
    };
  }

  const unpushed = held.filter((c) => (c.ahead ?? 0) > 0);
  if (unpushed.length > 0) {
    // Pushing to a branch a request is already open on amends that request
    // rather than opening a second one. Same verb, different outcome, so it is
    // a different stage — the label has to stop promising a request that is
    // already there.
    const amending = unpushed.every((c) => c.pullRequest);
    return amending
      ? {
          stage: "open-behind",
          label: `${name("Push", unpushed.length, held.length)} — updates the ${
            unpushed.length === 1 ? SHORT : `${SHORT}s`
          }`,
          url: single(unpushed),
          links,
          count: unpushed.length,
        }
      : {
          stage: "unpushed",
          label: name(`Push & open ${SHORT}`, unpushed.length, held.length),
          links,
          count: unpushed.length,
        };
  }

  const pushed = held.filter((c) => c.pushed === true);
  // A branch with nothing on it has nothing to open a request for, and every
  // git host refuses one. `pushed` alone used to be enough to offer it, so a
  // branch that was pushed empty got a button that could only fail.
  const toOpen = pushed.filter((c) => !c.pullRequest && carries(c));
  if (toOpen.length > 0) {
    return {
      stage: "pushed",
      label: toOpen.length === 1 ? `Open ${noun}` : `Open ${toOpen.length} ${noun}s`,
      links,
      count: toOpen.length,
    };
  }

  if (links.length > 0) {
    // What became of them, when every one has been answered the same way.
    // Mixed — one merged, one still open — stays `open`, because the honest
    // next thing is still the one waiting for a reviewer.
    const answered = held.filter((c) => c.pullRequest && c.pullState);
    if (answered.length === links.length) {
      if (answered.every((c) => c.pullState === "merged")) {
        return {
          stage: "merged",
          label: links.length === 1 ? "Merged" : `${links.length} merged`,
          url: single(held),
          links,
          count: links.length,
        };
      }
      if (answered.every((c) => c.pullState === "closed")) {
        return {
          stage: "closed",
          label: links.length === 1 ? "Closed" : `${links.length} closed`,
          url: single(held),
          links,
          count: links.length,
        };
      }
    }

    // A statement, not a verb. Nothing here is pressable, and what draws this
    // stage renders it as a link out rather than as the primary control.
    return {
      stage: "open",
      label: links.length === 1 ? `${Noun} open` : `${links.length} ${noun}s open`,
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
    blocked: held.some((c) => c.pushed === true)
      ? `This branch has no commits of its own, so there is nothing to open a ${noun} for.`
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
 * The long form, for somewhere with room to say it.
 *
 * Shown above the primary in the review sheet, so the whole sequence is written
 * out once even where the button itself is short.
 *
 * The first step's label is three steps: one press commits, pushes and opens a
 * request — so a button reading "Commit & push" was describing two thirds of
 * what it does, and the tab that opened on the request came as a surprise. The
 * button is abbreviated because it is also the one in the session header, where
 * there is no room; this is what carries the whole of it.
 */
export function sequence(ship: Ship, noun: string = "pull request"): string | undefined {
  if (ship.seeds) {
    switch (ship.stage) {
      case "uncommitted":
        return `Commits the files below and pushes them. This repository has no commits yet, so that push is what creates its trunk — there is nothing to open a ${noun} against.`;
      case "unpushed":
        return "Pushes the branch. This repository has no commits yet, so that push is what creates its trunk.";
      default:
        return undefined;
    }
  }
  switch (ship.stage) {
    case "uncommitted":
      return `Commits the files below, pushes the branch, and opens a ${noun}.`;
    case "unpushed":
      return `Pushes the branch and opens a ${noun}.`;
    case "pushed":
      return `Opens a ${noun} for what is already pushed.`;
    case "open-behind":
      return `Pushes onto the branch, which amends the ${noun} already open.`;
    default:
      return undefined;
  }
}

/**
 * What the trunk is called, when every repository agrees on a name.
 *
 * They usually do — one session, one branch name, one base — and naming it is
 * the difference between "Commit & push" and "Commit & push main". When they
 * disagree there is no one name to use and the generic word is honest.
 */
function trunkOf(held: CheckoutWork[]): string {
  const names = new Set(held.map((c) => c.base).filter(Boolean));
  return names.size === 1 ? [...names][0] : "the trunk";
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
  return ship.stage === "open" || ship.stage === "merged" || ship.stage === "closed";
}

/**
 * Whether a request is still out there waiting on somebody.
 *
 * What decides whether to keep asking the git host: a merged request does not
 * un-merge, so once every one is settled there is nothing left to poll for.
 */
export function awaiting(ship: Ship): boolean {
  return ship.stage === "open" || ship.stage === "open-behind";
}

/**
 * Whether ending this would lose something.
 *
 * Not knowing counts as at risk, and that is the safe way round: a checkout
 * nobody could read may hold anything, and the cost of warning about a clean
 * workspace is a sentence, while the cost of the reverse is somebody's
 * afternoon.
 */
export function atRisk(work?: CheckoutWork[]): boolean {
  return (
    !work ||
    work.some(
      (c) => c.uncommitted == null || c.uncommitted > 0 || (c.ahead ?? 0) > 0,
    )
  );
}
