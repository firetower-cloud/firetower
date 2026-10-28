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
 */

import type { Session } from "./generated/model";
import { inFlight, needsYou } from "./view";

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
      const lead = founder?.parentId ?? undefined;
      place.leadOf = lead && !place.runs.some((r) => r.id === lead) ? lead : undefined;
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
    const lead = place.leadOf ? placeOfRun.get(place.leadOf) : undefined;
    if (lead && lead.id !== place.id) {
      under.set(lead.id, [...(under.get(lead.id) ?? []), place]);
    } else {
      top.push(place);
    }
  }
  return top.flatMap((place) => [place, ...(under.get(place.id) ?? [])]);
}

/** Whether this place was started by a session in another place on the list. */
export function isChild(place: Workspace, places: Workspace[]): boolean {
  return (
    !!place.leadOf &&
    places.some((other) => other.id !== place.id && other.runs.some((r) => r.id === place.leadOf))
  );
}

/**
 * How many agents a place has delegated to and not yet ended, wherever they
 * run. What ending the place takes with it.
 */
export function childrenOf(place: Workspace, places: Workspace[]): number {
  const mine = new Set(place.runs.map((r) => r.id));
  const here = place.runs.filter((r) => r.parentId && mine.has(r.parentId) && r.status !== "Ended").length;
  const elsewhere = places.filter(
    (other) => other.id !== place.id && !!other.leadOf && mine.has(other.leadOf),
  ).length;
  return here + elsewhere;
}

/**
 * How many of a place's children are still at work: runs in this place that
 * one of its own runs asked for, and places elsewhere on the list it started.
 *
 * What a lead's row says while its own agent sits idle between a dispatch and
 * a result — its breathing dot is honest about the tree, and this is the
 * number behind it.
 */
export function childrenWorking(place: Workspace, places: Workspace[]): number {
  const mine = new Set(place.runs.map((r) => r.id));
  const here = place.runs.filter((r) => r.parentId && mine.has(r.parentId) && inFlight(r)).length;
  const elsewhere = places.filter(
    (other) => other.id !== place.id && !!other.leadOf && mine.has(other.leadOf) && doing(other) === "working",
  ).length;
  return here + elsewhere;
}

/** The last part of `owner/name`, which is what a rail has room for. */
/**
 * The place an id in the address belongs to.
 *
 * The id may name the workspace or any one run in it — a second agent is
 * opened by its own id and belongs to the place its sibling made. Both have
 * always worked.
 *
 * **And it still has to work once that run has ended.** Ending the agent you
 * were reading takes its id out of the running list, so an address naming it
 * matched no group at all: the workbench fell back to rebuilding the place
 * from the one session it could still fetch, and a workspace with six agents
 * in it drew one dead chip. Reopening fixed it, because the address was a live
 * id again — which is exactly the shape of a lookup that depends on the thing
 * it is looking for still existing.
 *
 * `belongsTo` is that session's `workspaceId`, which survives it. The group is
 * keyed by the same value, so the place is findable by what it *is* rather
 * than by which of its runs happened to be in the address.
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

export function shortRepo(slug: string): string {
  const cut = slug.lastIndexOf("/");
  return cut === -1 ? slug : slug.slice(cut + 1);
}
