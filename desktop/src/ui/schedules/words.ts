/**
 * What a stopped schedule says, counted rather than read.
 *
 * **`paused_reason` stores the rule that fired and nothing else** —
 * `three_failures`, `five_runs`, `overran`, `owner_disabled`, or null for a
 * person. The words come from the streak, which the server counts off the run
 * history on every read. That is deliberate: the sentence stays changeable
 * without a migration, and it cannot disagree with the rows underneath it.
 *
 * **Nothing here picks between "failing" and "asking".** A mixed streak gets
 * its own tag. There used to be a tie-break — "the most recent cause, the run
 * that tripped it" — and it was deleted when the column changed to store the
 * rule rather than the cause, because with the rule stored nothing has to
 * choose. Code that chooses is that deleted mechanism coming back.
 *
 * The three *Kept …* tags share a shape on purpose: they are one kind of
 * statement — your schedule is not working, and here is how. The fourth is
 * about the account rather than the schedule and keeps the plain sentence.
 */
import type { PausedReason, Schedule, Streak } from "~/api/generated/model";

/** The chip on a row. `null` for a schedule that is simply off. */
export function pauseTag(schedule: Schedule): string | null {
  if (schedule.active) return null;
  switch (schedule.pausedReason) {
    case "three_failures":
      return "Kept failing";
    case "five_runs":
      return fiveRunsTag(schedule.streak);
    case "overran":
      return "Kept overrunning";
    case "owner_disabled":
      return "Firetower stopped it";
    /* Null is a person, and that is already said by the *Next run* column
       reading **Paused** rather than **Stopped**. A tag would be the same
       fact twice. */
    default:
      return null;
  }
}

/**
 * The one rule that reads three ways.
 *
 * `five_runs` is neither *kept failing* nor *kept needing you*: the streak
 * says which, and when it holds both there is a third tag rather than a
 * choice between the first two.
 */
function fiveRunsTag(streak: Streak): string {
  const failing = streak.failures > 0 || streak.unreachable > 0;
  const asking = streak.questions > 0;
  if (failing && asking) return "Kept failing and asking";
  if (asking) return "Kept needing you";
  return "Kept failing";
}

/** Whether Firetower stopped this, rather than somebody. */
export function stoppedByFiretower(schedule: Schedule): boolean {
  return !schedule.active && !!schedule.pausedReason;
}

/** What the *Next run* column reads for a schedule that is off. */
export function offWord(schedule: Schedule): string {
  if (stoppedByFiretower(schedule)) return "Stopped";
  return schedule.approvedAt ? "Paused" : "Not on";
}

/** The sentence on a stopped schedule's own page: the headline, then why. */
export type PauseSays = { headline: string; because: string };

/**
 * Counted off the streak, so the box cannot say a number the rows below it
 * disagree with.
 *
 * `machine` is the machine the failures named, when they all named one — it
 * turns "five runs could not finish" into "five runs could not reach wren",
 * which is the difference between a sentence somebody can act on and one they
 * have to go and look up.
 */
export function pauseSays(schedule: Schedule, machine?: string | null): PauseSays | null {
  if (!stoppedByFiretower(schedule)) return null;
  const { failures, questions, unreachable } = schedule.streak;

  switch (schedule.pausedReason) {
    case "three_failures":
      return {
        headline: "Firetower stopped this schedule after three runs failed.",
        because:
          "Look at why they broke — usually configuration, a repository, or a machine. It will not run again until you turn it on.",
      };

    case "five_runs": {
      if (questions > 0 && failures === 0 && unreachable === 0) {
        return {
          headline: "Firetower stopped this schedule after five runs needed you.",
          because: `A schedule that has to be answered every morning is not running unattended. The ${count(questions)} ${questions === 1 ? "question" : "questions"} are still waiting in their workspaces. It will not run again until you turn it on.`,
        };
      }
      if (questions === 0) {
        /* Every counted run was a failure of some kind. Where they all named
           one machine, the sentence names it. */
        return {
          headline: machine
            ? `Firetower stopped this schedule after five runs could not reach ${machine}.`
            : "Firetower stopped this schedule after five runs failed.",
          because: machine
            ? "Nothing was wrong with what it was asked to do. It will not run again until you turn it on."
            : "Look at why they broke. It will not run again until you turn it on.",
        };
      }
      /* Both populations. **Neither on its own would have stopped it**, which
         is the thing worth saying — otherwise the reader looks for three
         failures and finds two. */
      const broke = failures + unreachable;
      return {
        headline: "Firetower stopped this schedule after five runs in a row did not finish.",
        because: `${cap(count(broke))} of them failed and ${count(questions)} stopped to ask. Neither on its own would have stopped it. It will not run again until you turn it on.`,
      };
    }

    case "overran":
      return {
        headline: "Firetower stopped this schedule after two runs overran.",
        because:
          "A run is still going and nothing stopped it. The reason is in that workspace rather than in this history. It will not run again until you turn it on.",
      };

    case "owner_disabled":
      return {
        headline: "Firetower stopped this schedule while your account was disabled.",
        because: "Nothing was wrong with the schedule. It will not run again until you turn it on.",
      };

    default:
      return null;
  }
}

/** Small numbers in words, the way the rest of this product writes them. */
function count(n: number): string {
  return ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"][n] ?? String(n);
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Which rule stopped it, for anything that wants the bare word. */
export function ruleName(reason: PausedReason | null | undefined): string | null {
  return reason ?? null;
}
