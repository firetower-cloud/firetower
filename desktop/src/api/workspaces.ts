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
    });
  }

  const groups: [string, Workspace[]][] = [...byRepo].map(([repo, places]) => [
    repo,
    [...places.values()],
  ]);

  return { groups, total: groups.reduce((n, [, places]) => n + places.length, 0) };
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
