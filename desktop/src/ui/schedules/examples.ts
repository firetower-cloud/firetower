/**
 * Six things a team would actually put on a clock.
 *
 * **These are the empty state.** A library with nothing in it draws these
 * rather than an illustration and a sentence about emptiness: what somebody
 * needs on that screen is not to be told it is empty, it is an idea of what
 * the thing is for. Each is expressed the way Firetower expresses work — a
 * prompt, a cadence, and what the run leaves behind.
 *
 * **None carries a profile.** A profile is a persona somebody has made for
 * themselves, and shipping examples that name one would be offering a thing
 * that does not exist in their installation.
 */
import type { Cadence } from "~/api/generated/model";

export type Example = {
  name: string;
  /** The lucide glyph, by name, so the list stays data. */
  icon: "package" | "refresh" | "book" | "inbox" | "tree" | "scroll";
  says: string;
  makes: string;
  does: string;
  prompt: string;
  cadence: Cadence;
};

export const EXAMPLES: Example[] = [
  {
    name: "Dependency audit",
    icon: "package",
    says: "Every Monday at 07:00",
    makes: "Opens a pull request",
    does: "Takes the patch and minor updates whose tests pass. Lists the major ones for you to decide.",
    prompt:
      "Check every dependency in this repository for a newer version and for anything with a published advisory. Open one pull request that takes only the patch and minor bumps whose tests pass, and leave a comment listing the major bumps you did not take and why.",
    cadence: { kind: "weekly", at: "07:00", day: "monday" },
  },
  {
    name: "Flaky test hunt",
    icon: "refresh",
    says: "Every day at 02:00",
    makes: "Opens issues",
    does: "Runs the test suite ten times and opens an issue for every test that both passed and failed.",
    prompt:
      "Run the test suite ten times over. List every test that passed at least once and failed at least once, with its failure output. Open an issue for each one that is not already tracked, and nothing else.",
    cadence: { kind: "daily", at: "02:00" },
  },
  {
    name: "Docs drift check",
    icon: "book",
    says: "Every Friday at 16:00",
    makes: "Opens a pull request",
    does: "Finds statements in the docs that the code no longer matches, and fixes the clear ones.",
    prompt:
      "Compare the README and everything under docs/ against the code as it stands. List every statement that is no longer true, with the file and line that contradicts it. Fix the ones where there is only one possible correction and open a pull request; leave the rest as a list.",
    cadence: { kind: "weekly", at: "16:00", day: "friday" },
  },
  {
    name: "Triage what came in",
    icon: "inbox",
    says: "Every weekday at 08:30",
    makes: "Posts comments and labels",
    does: "Reads new issues and says where each belongs and whether it still reproduces. Changes no code.",
    prompt:
      "Read every issue opened since your last run. For each, say which part of the codebase it is about, whether it still reproduces on main, and what the smallest fix would be. Label them and post your reading as a comment. Change no code.",
    cadence: { kind: "weekdays", at: "08:30" },
  },
  {
    name: "Close the loop on stale branches",
    icon: "tree",
    says: "Every first Monday at 09:00",
    makes: "Writes a list",
    does: "Lists branches with no commits for 30 days and says whether each still applies.",
    prompt:
      "List every branch pushed from this repository with no commit in 30 days and no open pull request. For each, say in one line what it was trying to do and whether it still applies. Delete nothing.",
    cadence: { kind: "monthly", at: "09:00", on: { kind: "nth", nth: 1, day: "monday" } },
  },
  {
    name: "Weekly review",
    icon: "scroll",
    says: "Every Friday at 17:00",
    makes: "Publishes an artifact",
    does: "Summarises what shipped this week, what was reverted and who reviewed it.",
    prompt:
      'Summarise what this repository did this week: every merged pull request with one line on what it changed, who reviewed it, and anything that was reverted. Publish it as an artifact called "This week".',
    cadence: { kind: "weekly", at: "17:00", day: "friday" },
  },
];
