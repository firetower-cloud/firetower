/**
 * The workspace's repositories: what one is doing, and checking another in.
 *
 * `POST /sessions/{id}/repos` takes one repository and answers when that one
 * has landed. Checking three in is therefore three requests, and the only
 * place that knew how they were going was the popover that started them — so
 * closing it lost the run, and a refusal in the middle of it was a red line
 * nobody was looking at.
 *
 * This is that run, held where anything can read it. The popover writes to it
 * and the conversation draws it, which is the right place for it to end up:
 * checking a repository in *is* something that happened to this workspace, and
 * the transcript is where this app says what happened to a workspace.
 *
 * In memory rather than in storage. A reload takes the loop driving it with
 * it, and a card left saying "fetching" for a request nobody is making any
 * more is worse than no card — what is actually checked out is on the session,
 * which survives on its own.
 */
import { useSyncExternalStore } from "react";
import type { CheckoutWork } from "./generated/model";

/**
 * One checkout's state, in the few words a row has for it.
 *
 * **Absent is not zero.** A host nobody can reach reports no numbers at all,
 * and a workspace with nothing left to do reports zeros — drawn the same way,
 * a machine that stopped answering reads as an afternoon's work that is safely
 * committed. So the unknown case says so, in the colour that means "look at
 * this" rather than the one that means "fine".
 */
export function howItIsDoing(
  work: CheckoutWork | undefined,
  ended: boolean,
): { text: string; tone: string } {
  if (!work) return { text: ended ? "checked out" : "reading…", tone: "text-mute" };
  if (work.pullState === "merged") return { text: "merged", tone: "text-sage" };
  if (work.pullRequest) return { text: "pull request open", tone: "text-sage" };
  if (work.uncommitted == null) return { text: "no answer from the machine", tone: "text-kind-data" };
  if (work.uncommitted > 0) return { text: `${work.uncommitted} uncommitted`, tone: "text-dim" };
  if (work.pushed === false && (work.commits ?? 0) > 0) return { text: `${work.commits} to push`, tone: "text-dim" };
  if ((work.commits ?? 0) > 0) return { text: `${work.commits} committed`, tone: "text-dim" };
  return { text: "nothing changed yet", tone: "text-mute" };
}

export type Landed = "waiting" | "fetching" | "done" | "failed";

/** One repository in a run, and how far it got. */
export type Landing = {
  slug: string;
  state: Landed;
  /** Where it landed, or why it did not. */
  detail?: string;
};

/** One press of "check in", and everything it was asked to bring. */
export type Run = {
  id: string;
  startedAt: number;
  repos: Landing[];
};

const runs = new Map<string, Run[]>();
const watching = new Set<() => void>();
const NONE: Run[] = [];

function changed() {
  for (const tell of watching) tell();
}

/**
 * Every run on one session, oldest first.
 *
 * The same array until it actually changes — `useSyncExternalStore` compares
 * what the snapshot returns against what it returned last time, and a fresh
 * array each read is an infinite render.
 */
export function runsOn(session: string): Run[] {
  return runs.get(session) ?? NONE;
}

/** The same, as something a screen can subscribe to. */
export function useCheckouts(session: string): Run[] {
  return useSyncExternalStore(
    (onChange) => {
      watching.add(onChange);
      return () => void watching.delete(onChange);
    },
    () => runsOn(session),
    () => NONE,
  );
}

/** Start one, with every repository waiting. Returns the run's id. */
export function beginCheckout(session: string, slugs: string[]): string {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const run: Run = {
    id,
    startedAt: Date.now(),
    repos: slugs.map((slug) => ({ slug, state: "waiting" as Landed })),
  };
  runs.set(session, [...(runs.get(session) ?? []), run]);
  changed();
  return id;
}

/** Move one repository along. */
export function markCheckout(session: string, run: string, slug: string, state: Landed, detail?: string) {
  const held = runs.get(session);
  if (!held) return;
  runs.set(
    session,
    held.map((r) =>
      r.id === run
        ? { ...r, repos: r.repos.map((p) => (p.slug === slug ? { ...p, state, detail } : p)) }
        : r,
    ),
  );
  changed();
}

/** Take a finished run off the transcript. */
export function forgetCheckout(session: string, run: string) {
  const held = runs.get(session);
  if (!held) return;
  runs.set(session, held.filter((r) => r.id !== run));
  changed();
}

/** Whether a run is over, however it went. */
export const settled = (run: Run) => run.repos.every((r) => r.state === "done" || r.state === "failed");
export const refused = (run: Run) => run.repos.filter((r) => r.state === "failed").length;
export const landed = (run: Run) => run.repos.filter((r) => r.state === "done").length;
