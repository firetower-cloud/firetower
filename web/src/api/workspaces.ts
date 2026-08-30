/**
 * Sessions, read as the places they work in.
 *
 * The API returns sessions; a person thinks in worktrees. A workspace is a
 * checkout on a host with any number of agents in it, and the first session of
 * one carries the workspace's own id — so grouping by `workspaceId` and taking
 * the name from the first run gives back the shape somebody actually has.
 *
 * Shared because the rail and the dashboard both draw it, and reading the fleet
 * twice over should not mean reading it two different ways.
 */

import type { Session } from "./generated/model";
import { inFlight, needsYou } from "./view";

/** A worktree, and the agents working in it. */
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
export function shortRepo(slug: string): string {
  const cut = slug.lastIndexOf("/");
  return cut === -1 ? slug : slug.slice(cut + 1);
}
