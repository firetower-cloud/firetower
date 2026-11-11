/**
 * Sessions, read as the places they work in.
 *
 * The API returns sessions; a person thinks in workspaces. A workspace is a
 * checkout on a host with any number of agents in it, and the first session of
 * one carries the workspace's own id — so grouping by `workspaceId` and taking
 * the name from the first run gives back the shape somebody actually has.
 *
 * Shared because the rail and the dashboard both draw it, and reading the fleet
 * twice over should not mean reading it two different ways.
 *
 * **A subset of the desk's copy, deliberately.** `desktop/src/api/workspaces.ts`
 * also exports `familyOf`, `placeBeat`, `speaksFor`, `flat`, `rowLabel`,
 * `childrenElsewhere` and `childrenWorking`; each of those answers for a
 * surface the phone has not got — a rail that hides delegated children under
 * one mark, an end-workspace confirmation that counts what goes with it.
 * Everything that says what a *place* is, and whose it is, is the same code
 * under the same names. Add from there rather than inventing beside it, and
 * when a third reason arrives, extract the package the README promises.
 */

import type { Session } from "./generated/model";
import { BEAT, inFlight, needsYou, type Beat } from "./view";

/** A workspace: a checkout on a host, and the agents working in it. */
export type Workspace = {
  id: string;
  name: string;
  branch?: string;
  runs: Session[];
  /**
   * The session that asked for this place, when a session did.
   *
   * A child's row is drawn under its lead's and sorts straight after it rather
   * than by its own age, so a lead and what it delegated read as one piece of
   * work. Only a child in a workspace of its own has this: one started *in* the
   * lead's workspace is simply another run of that place, and shows as another
   * mark on the lead's row.
   */
  leadOf?: string;
};

/** Repositories, each with the workspaces cut from it. */
export type Repositories = {
  groups: [string, Workspace[]][];
  total: number;
};

/**
 * What the place as a whole is doing.
 *
 * Not any one agent's status. `unfinished` is the wrong question here — it
 * means "still holds a host", so an idle workspace and a busy one both answer
 * yes, and everything reads as working.
 */
export function doing(place: Workspace): "waiting" | "working" | "idle" {
  if (place.runs.some(inFlight)) return "working";
  if (place.runs.some(needsYou)) return "waiting";
  return "idle";
}

export function group(sessions: Session[]): Repositories {
  const byRepo = new Map<string, Map<string, Workspace>>();

  // What needs you first, then most recent — so the row worth opening is the
  // one nearest the top of its group.
  const ordered = [...sessions].sort((a, b) => {
    if (needsYou(a) !== needsYou(b)) return needsYou(a) ? -1 : 1;
    return b.createdAt.localeCompare(a.createdAt);
  });

  for (const session of ordered) {
    const repo = session.repo ?? "no repository";
    const id = session.workspaceId ?? session.id;

    const places = byRepo.get(repo) ?? new Map<string, Workspace>();
    byRepo.set(repo, places);

    const held = places.get(id);
    if (held) {
      held.runs.push(session);
      continue;
    }
    places.set(id, {
      id,
      name: session.name,
      branch: session.branch ?? undefined,
      runs: [session],
      leadOf: session.parentId ?? undefined,
    });
  }

  // Whose place each is. The founding session — the one the place is named
  // after — says who asked for it; whichever run happened to be seen first
  // does not. And a lead that is one of the place's own runs is no lead at
  // all: a child started *in* a workspace is a run of it, not a place of its
  // own, and a place is never under itself.
  for (const places of byRepo.values()) {
    for (const place of places.values()) {
      const founder = place.runs.find((r) => r.id === place.id);
      // Named after its founder, not whichever run was seen first: a workspace
      // with a same-workspace child in it must keep the lead's name, not take
      // the child's. Only when the founder is still around to say.
      if (founder) place.name = founder.name;
      const asked = founder?.parentId ?? undefined;
      place.leadOf = asked && !place.runs.some((r) => r.id === asked) ? asked : undefined;
    }
  }

  const groups: [string, Workspace[]][] = [...byRepo].map(([repo, places]) => [
    repo,
    underTheirLeads([...places.values()]),
  ]);

  return { groups, total: groups.reduce((n, [, places]) => n + places.length, 0) };
}

/**
 * Each child straight after its lead.
 *
 * Within one repository: a child cut from a different repository than its
 * lead is listed under its own, where its branch is. Everything keeps the
 * order it arrived in — needs-you first, then newest — so children under one
 * lead still read newest first, and a child whose lead is nowhere in the list
 * stays where its own age put it.
 */
function underTheirLeads(places: Workspace[]): Workspace[] {
  const placeOfRun = new Map<string, Workspace>();
  for (const place of places) for (const run of place.runs) placeOfRun.set(run.id, place);

  const under = new Map<string, Workspace[]>();
  const top: Workspace[] = [];
  for (const place of places) {
    /* `above` where the desk writes `lead`: this file exports a `lead()` of
       its own for the run that *speaks* for a place, and the two are
       different questions. Shadowing one with the other is a trap. */
    const above = place.leadOf ? placeOfRun.get(place.leadOf) : undefined;
    if (above && above.id !== place.id) {
      under.set(above.id, [...(under.get(above.id) ?? []), place]);
    } else {
      top.push(place);
    }
  }
  return top.flatMap((place) => [place, ...(under.get(place.id) ?? [])]);
}

/** The place whose session started this one, if it is on the list. */
export function leadPlace(place: Workspace, places: Workspace[]): Workspace | undefined {
  if (!place.leadOf) return undefined;
  return places.find((other) => other.id !== place.id && other.runs.some((r) => r.id === place.leadOf));
}

/** Whether this place was started by a session in another place on the list. */
export function isChild(place: Workspace, places: Workspace[]): boolean {
  return !!leadPlace(place, places);
}

/**
 * The place an id in the address belongs to.
 *
 * The id may name the workspace or any one run in it — a second agent is
 * opened by its own id and belongs to the place its sibling made. Both have
 * always worked.
 *
 * **And it still has to work once that run has ended.** Ending the agent you
 * were reading takes its id out of the running list, so an address naming it
 * matched no group at all. `belongsTo` is that session's `workspaceId`, which
 * survives it: the group is keyed by the same value, so the place is findable
 * by what it *is* rather than by which of its runs happened to be in the
 * address.
 *
 * This is also the one question a tap on a team member asks — a row names a
 * session and the phone routes to a *workspace*, and `~/workspace/[id]` finds
 * its place by `Workspace.id`. Deciding that here is what keeps the Overview
 * and the route agreeing about which row opens what.
 */
export function placeOf(
  places: Workspace[],
  id: string,
  belongsTo?: string | null,
): Workspace | undefined {
  return places.find(
    (p) =>
      p.id === id ||
      (!!belongsTo && p.id === belongsTo) ||
      p.runs.some((r) => r.id === id),
  );
}

/** The last part of `owner/name`, which is what a rail has room for. */
export function shortRepo(slug: string): string {
  const cut = slug.lastIndexOf("/");
  return cut === -1 ? slug : slug.slice(cut + 1);
}

/**
 * The run that speaks for the place.
 *
 * A workspace has several agents in it and a row has one dot and one line, so
 * something has to choose which run they describe. Letting the dot read
 * `runs[0]` while the line read `doing()` is how a row came to show a sage
 * tick beside the word "Working": `group()` sorts what-needs-you first, so
 * `runs[0]` is only the representative run when the place is waiting.
 *
 * Choosing once, here, is what keeps them from disagreeing — the same reason
 * `BEAT` exists rather than two lists of colours.
 */
export function lead(place: Workspace): Session {
  const what = doing(place);
  const match =
    what === "working"
      ? place.runs.find(inFlight)
      : what === "waiting"
        ? place.runs.find(needsYou)
        : undefined;
  /* A workspace is a checkout with several agents in it, and a shell running
     beside the work — `cargo watch`, a dev server — is not what anybody
     opened it to read. The desk skips those and this did not, which is one
     way the two clients could show a different transcript for the same row. */
  return match ?? place.runs.find((r) => r.agent !== "Shell") ?? place.runs[0];
}

/**
 * The order a list of workspaces reads in. **Not sections — an order.**
 *
 * Grouped is the one not to ship: a workspace changes state while you are
 * looking at it, and the row you reached for jumps sections under your thumb.
 * Flat and status-ordered has no such frame.
 *
 * `Record<Beat, …>` rather than `Record<string, …>`, so adding a beat is a
 * build error here instead of a silent `undefined` in the comparator, which
 * would sort the new one to an arbitrary place.
 *
 * Shared because two surfaces draw this list — the Workspaces destination and
 * the home's docked column, which is the same list previewed — and two copies
 * of a comparator are two chances to disagree about what comes first.
 */
export const RANK: Record<Beat, number> = { blocked: 0, broken: 1, working: 2, done: 3, over: 4 };

/** The same list, in that order. A copy: `sort` is in place and the caller's
 *  array is memoised upstream. */
export function ranked(places: Workspace[]): Workspace[] {
  return places.slice().sort((a, b) => RANK[BEAT[lead(a).status]] - RANK[BEAT[lead(b).status]]);
}
