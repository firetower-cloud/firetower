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
import { beatOf, inFlight, needsYou, type Beat } from "./view";

/** A workspace: a checkout on a host, and the agents working in it. */
export type Workspace = {
  id: string;
  name: string;
  branch?: string;
  /**
   * When the place was cut — its founding session's clock, not whichever run
   * sorted to the front. A lead working for an hour that delegates to a child
   * a minute ago is an hour-old workspace, and used to say "1m".
   */
  startedAt: string;
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

/**
 * Every agent a place is answerable for: the runs in it, and the runs of any
 * workspace one of them started.
 *
 * `places` is the *whole* list, not the one a screen happens to be drawing. A
 * child with a workspace of its own is hidden from the rail — it belongs under
 * its lead in the Overview — which is precisely why the lead's row has to
 * speak for it. Handed the list it is already drawing, this finds nothing,
 * because the thing it is looking for is the thing that list left out.
 *
 * One hop is the whole of the tree: delegation is flat by construction, and
 * `delegate.rs` refuses a child that tries to spawn.
 */
export function familyOf(place: Workspace, places: Workspace[]): Session[] {
  const mine = new Set(place.runs.map((r) => r.id));
  return [
    ...place.runs,
    ...places.flatMap((other) =>
      other.id !== place.id && !!other.leadOf && mine.has(other.leadOf) ? other.runs : [],
    ),
  ];
}

/**
 * Which beat a place wears when more than one is true of it. First wins.
 *
 * - **blocked** first. Ember is spent on being stopped-and-stuck and on
 *   nothing else (`beat.test.ts`), and a sibling still working does not make
 *   an unanswered question any less unanswered.
 * - **working** next: a place is at rest only when nothing in it is going.
 * - **broken**, then **done** — both at rest, and a failure is the louder of
 *   the two: it will not finish on its own, whatever else here did.
 * - **over** only when every one of them has ended.
 */
const PRECEDENCE: Beat[] = ["blocked", "working", "broken", "done", "over"];

/** The one of these whose beat comes first. Ties keep the order they arrived
 *  in, which is the place's own runs before anything it delegated. */
function loudest(runs: Session[]): Session {
  let best = runs[0];
  let rank = PRECEDENCE.indexOf(beatOf(best));
  for (const run of runs.slice(1)) {
    const at = PRECEDENCE.indexOf(beatOf(run));
    if (at < rank) [best, rank] = [run, at];
  }
  return best;
}

/**
 * The agent that speaks for a place — the one whose status a single mark on a
 * row should show.
 *
 * Its *own* agents, deliberately. The dashboard and the fleet page list every
 * workspace there is, so a delegated child has a row of its own a line below
 * its lead; a lead that also spoke for its children would say the same thing
 * twice. The rail is the one that hides them, and the rail asks `placeBeat`
 * instead.
 *
 * `Signal` draws more than a colour — a tick for a hand-back, a cross for a
 * failure, a breathing dot for work — so these screens need the run, not the
 * beat.
 */
export function speaksFor(place: Workspace): Session {
  return loudest(place.runs);
}

/**
 * What a place reads as, in one beat — the whole of it, family included.
 *
 * The rail drew `beatOf(place.runs[0])`, and `group()` sorts whichever run
 * wants you to the front. So a manager that had handed back painted its row
 * sage — *finished, nothing owed* — while an agent it had delegated to was
 * still typing, and the same workspace's Overview said "2 agents · 1 working"
 * one panel away. Two screens, one workspace, two answers, and the one that
 * was wrong was on the screen you glance at rather than the one you open.
 *
 * For the rail, which hides a delegated child under its lead: with nothing
 * else on screen to correct it, this row has to be true of the whole family.
 * `PRECEDENCE` says which beat wins.
 *
 * `doing()` is still the right question for a *word* — "working", "your move"
 * — and keeps its own order, where in-flight wins. This is the question for a
 * colour. The split is the one `view.ts` already draws between `needsYou` and
 * `beatOf`: what wants a human, and what it looks like, are not the same
 * question.
 */
export function placeBeat(place: Workspace, places: Workspace[]): Beat {
  return beatOf(loudest(familyOf(place, places)));
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
      startedAt: session.createdAt,
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
      // And aged from it, for the same reason. With the founder gone, the
      // oldest run still here is the best the place can say for itself.
      place.startedAt = founder?.createdAt ?? place.runs.reduce((a, r) => (r.createdAt < a ? r.createdAt : a), place.runs[0].createdAt);
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

/**
 * The same workspaces, out of their repository groups and in one order.
 *
 * The rail's panel is a flat list — a name and one timestamp — because a row
 * that carries a repository, a branch, a machine and a state is a paragraph,
 * and a column of paragraphs is unscannable. `group()` is still what builds
 * the places, because that is where a child knowing its lead lives; this only
 * takes the grouping back off and restores the one order that matters:
 * **what needs you first, then most recent.** Within a group that order is
 * already true, but across groups it is not — a repository with nothing
 * waiting would otherwise push a question below it.
 *
 * Children are kept, straight after their lead, exactly as the groups had
 * them — a lead and what it delegated is one piece of work wherever it is
 * drawn.
 */
export function flat(repos: Repositories): Workspace[] {
  const places = repos.groups.flatMap(([, inside]) => inside);
  const waiting = (place: Workspace) => place.runs.some(needsYou);
  const started = (place: Workspace) => place.runs[0]?.createdAt ?? "";
  /* Leads carry their children with them rather than sorting against them. */
  const leadOf = new Map<string, Workspace>();
  for (const place of places) for (const run of place.runs) leadOf.set(run.id, place);
  const under = new Map<string, Workspace[]>();
  const top: Workspace[] = [];
  for (const place of places) {
    const lead = place.leadOf ? leadOf.get(place.leadOf) : undefined;
    if (lead && lead.id !== place.id) under.set(lead.id, [...(under.get(lead.id) ?? []), place]);
    else top.push(place);
  }
  top.sort((a, b) => {
    if (waiting(a) !== waiting(b)) return waiting(a) ? -1 : 1;
    return started(b).localeCompare(started(a));
  });
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
 * What a row is called where its lead is shown right above it.
 *
 * A child is named "<lead> / <what>" so it still reads on its own — in a flat
 * list, in search, on the child's own page. Drawn nested under its lead, that
 * prefix is said twice, so drop it and show just the part that differs. Only
 * when the lead is actually on this list: a flat view keeps the full name,
 * which is the only thing carrying the association there.
 */
export function rowLabel(place: Workspace, places: Workspace[]): string {
  const lead = leadPlace(place, places);
  const prefix = lead ? `${lead.name} / ` : "";
  return prefix && place.name.startsWith(prefix) ? place.name.slice(prefix.length) : place.name;
}

/**
 * How many agents a place has started **outside itself** and not yet ended.
 * What ending the place takes with it that is not already in it.
 *
 * Elsewhere only, and the word is load-bearing. The one question that asks
 * this counts the agents in the place first — "3 agents stop, and so do the 2
 * it started elsewhere" — and this used to add the place's *own* children on
 * top, so a lead with one child beside it in the same workspace was announced
 * as two agents stopping and one more somewhere else, which was the same
 * agent, counted twice and put on a machine it was not on.
 */
export function childrenElsewhere(place: Workspace, places: Workspace[]): number {
  const mine = new Set(place.runs.map((r) => r.id));
  return places.filter(
    (other) => other.id !== place.id && !!other.leadOf && mine.has(other.leadOf),
  ).length;
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
