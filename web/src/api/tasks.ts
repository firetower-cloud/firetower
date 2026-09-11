/**
 * What the chips are actually asking for, written out.
 *
 * The line under the controls is not decoration: it is where somebody learns
 * the syntax well enough to type past the chips. So it has to be the query
 * that was sent, in the dialect of the tracker it was sent to — a Linear
 * search described in GitHub's words teaches the wrong thing.
 *
 * It also has to honour the same rule the server does: a qualifier somebody
 * typed replaces the chip beside it rather than joining it, because sending
 * both means one of them is silently ignored.
 */

import type { ScopeKind, TaskKind, TaskState } from "@/src/api/generated/model";

export type Asking = {
  /** The repository or the team, whichever this tracker has. */
  scope?: string;
  kind: TaskKind;
  state: TaskState;
  mine: boolean;
  /** The query box, verbatim. */
  q: string;
};

/** Whether the typed query already names a qualifier. */
function names(q: string, qualifier: string): boolean {
  return q.includes(`${qualifier}:`);
}

function github(ask: Asking): string[] {
  const parts: string[] = [];

  if (!names(ask.q, "repo")) parts.push(ask.scope ? `repo:${ask.scope}` : "your repositories");
  if (!ask.q.includes("is:issue") && !ask.q.includes("is:pr")) {
    parts.push(ask.kind === "pullRequest" ? "is:pr" : "is:issue");
  }
  if (!ask.q.includes("is:open") && !ask.q.includes("is:closed")) {
    parts.push(ask.state === "closed" ? "is:closed" : "is:open");
  }
  if (ask.mine && !names(ask.q, "assignee")) parts.push("assignee:@me");

  return parts;
}

function linear(ask: Asking): string[] {
  const parts: string[] = [];

  if (!names(ask.q, "team")) parts.push(ask.scope ? `team:${ask.scope}` : "your teams");
  if (!names(ask.q, "state") && !names(ask.q, "status")) {
    parts.push(ask.state === "closed" ? "state:closed" : "state:open");
  }
  if (ask.mine && !names(ask.q, "assignee")) parts.push("assignee:me");

  return parts;
}

/** The whole request, as one string, in the tracker's own words. */
export function describeQuery(source: string, ask: Asking): string {
  const parts = source === "linear" ? linear(ask) : github(ask);
  const typed = ask.q.trim();
  return [...parts, typed].filter(Boolean).join(" ");
}

/** What the query box should suggest, which differs by tracker. */
export function queryHint(source: string): string {
  return source === "linear" ? "label:bug state:started priority:1" : "label:bug sort:updated-desc";
}

/** What the scope picker's "everything" option is called. */
export function everything(scopeKind: ScopeKind): string {
  return scopeKind === "teams" ? "All your teams" : "All your repositories";
}

/**
 * Where a cursor-paged list resumes from, and how far back it can go.
 *
 * A cursor only points forward, so going back means remembering the ones
 * already used. The first entry is `undefined`, which is the first page.
 */
export type Trail = {
  cursors: (string | undefined)[];
  at: number;
};

export const START: Trail = { cursors: [undefined], at: 0 };

/** Move on, remembering where this page started so Previous can come back. */
export function forward(trail: Trail, next: string): Trail {
  return {
    cursors: [...trail.cursors.slice(0, trail.at + 1), next],
    at: trail.at + 1,
  };
}

export function back(trail: Trail): Trail {
  return { ...trail, at: Math.max(0, trail.at - 1) };
}

export function cursorAt(trail: Trail): string | undefined {
  return trail.cursors[trail.at];
}
