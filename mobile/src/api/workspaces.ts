/**
 * Sessions, read as the places they work in.
 *
 * The API returns sessions; a person thinks in workspaces. A workspace is a
 * checkout on a host with any number of agents in it, and every run in one
 * carries its `workspaceId` — so grouping by that gives back the shape
 * somebody actually has, and `founder()` says which of those runs the place
 * is named after. Not whichever sorted first: that was a bug for as long as
 * this file has existed, and the comment here used to assert it.
 *
 * Shared because the rail and the dashboard both draw it, and reading the fleet
 * twice over should not mean reading it two different ways.
 *
 * **Most of the desk's copy, and the same code under the same names.** The
 * phone's lists now hide a delegated child under its lead exactly as the
 * desk's rail does, so `familyOf`, `placeBeat`, `rowLabel` and
 * `childrenElsewhere` came across from `desktop/src/api/workspaces.ts` rather
 * than being derived a second time beside them — a second answer to *what is
 * this place answerable for* is how two screens come to disagree about one
 * workspace. `speaksFor`, `flat` and `childrenWorking` are still only the
 * desk's, and `asking`, `lastMoved` and `childLine` are only the phone's:
 * what a row says about its children is a row's business, and the desk's rail
 * has no room for a second line. When a third client wants any of it, extract
 * the package the README promises.
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

/**
 * The run that founded the place: the one it is named after, and the one a
 * list means when it opens a workspace.
 *
 * **`r.id === place.id` was the whole of this, and it almost never matched.**
 * `group()` files a place under `workspaceId ?? id`, so that test only finds
 * the founder of a workspace with no id of its own. For every real workspace
 * it found nothing, the place kept whichever run sorted to the front — needs
 * you first, then newest — and three things followed from it: the Workspaces
 * list and the home named a workspace after a subagent in it, a child
 * workspace never nested under its lead, and opening a workspace lit a
 * child's row in the Team panel as the one you were reading.
 *
 * Found by shape instead: the run in this place that was not started by
 * another run in it. A subagent sharing the checkout has its lead here, so it
 * is skipped; the lead itself — or an agent a person started — has no parent
 * here and qualifies. Oldest when several do, which is also the answer once
 * the founder has ended and only what it delegated is left: the oldest run
 * still here is the best the place can say for itself.
 */
export function founder(place: Workspace): Session | undefined {
  const own = new Set(place.runs.map((r) => r.id));
  let eldest: Session | undefined;
  for (const run of place.runs) {
    /* A place with no workspace of its own is filed under this run's id,
       which says outright that it founded it. */
    if (run.id === place.id) return run;
    if (run.parentId && own.has(run.parentId)) continue;
    if (!eldest || run.createdAt < eldest.createdAt) eldest = run;
  }
  return eldest;
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
      const first = founder(place);
      // Named after its founder, not whichever run was seen first: a workspace
      // with a same-workspace child in it must keep the lead's name, not take
      // the child's.
      if (first) place.name = first.name;
      const asked = first?.parentId ?? undefined;
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
 * What a row is called where its lead is shown right above it — or, here,
 * where its lead is the only row shown at all.
 *
 * A child is named "<lead> / <what>" so it still reads on its own: in a flat
 * list, in search, on the child's own page. Said under its lead, that prefix
 * is said twice, so drop it and show just the part that differs. Only when the
 * lead is actually on this list — a flat view keeps the full name, which is
 * the only thing carrying the association there.
 */
export function rowLabel(place: Workspace, places: Workspace[]): string {
  const above = leadPlace(place, places);
  const prefix = above ? `${above.name} / ` : "";
  return prefix && place.name.startsWith(prefix) ? place.name.slice(prefix.length) : place.name;
}

/**
 * The places this one started **elsewhere** and has not ended: the children
 * that have checkouts of their own, and therefore rows of their own.
 *
 * Elsewhere only, and the word is load-bearing. A child started *in* this
 * workspace is already one of `place.runs` — counting those as well is how the
 * desk once announced the same agent twice, on a machine it was not on.
 *
 * **The desk's returns the number; this returns the children.** Same question,
 * and `.length` is the desk's answer. The phone's row has to *name* one of
 * them when one of them is blocked, which a count cannot do, and deriving the
 * set twice under two names is how the two would drift.
 */
export function childrenElsewhere(place: Workspace, places: Workspace[]): Workspace[] {
  const mine = new Set(place.runs.map((r) => r.id));
  return places.filter((other) => other.id !== place.id && !!other.leadOf && mine.has(other.leadOf));
}

/**
 * Every agent a place is answerable for: the runs in it, and the runs of any
 * workspace one of them started.
 *
 * `places` is the *whole* list, not the one a screen happens to be drawing. A
 * child with a workspace of its own is now hidden from both lists — it belongs
 * under its lead — which is precisely why the lead's row has to speak for it.
 * Handed the list it is already drawing, this finds nothing, because the thing
 * it is looking for is the thing that list left out.
 *
 * One hop is the whole of the tree: delegation is flat by construction, and
 * `delegate.rs` refuses a child that tries to spawn.
 */
export function familyOf(place: Workspace, places: Workspace[]): Session[] {
  return [...place.runs, ...childrenElsewhere(place, places).flatMap((other) => other.runs)];
}

/**
 * Which beat a place wears when more than one is true of it. First wins.
 *
 * - **blocked** first. Ember is spent on being stopped-and-stuck and on
 *   nothing else, and a sibling still working does not make an unanswered
 *   question any less unanswered.
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
  let rank = PRECEDENCE.indexOf(BEAT[best.status]);
  for (const run of runs.slice(1)) {
    const at = PRECEDENCE.indexOf(BEAT[run.status]);
    if (at < rank) [best, rank] = [run, at];
  }
  return best;
}

/**
 * What a place reads as, in one beat — the whole of it, family included.
 *
 * A row drew `BEAT[lead(place).status]`, which is the place's *own* agents. So
 * a manager sitting idle painted its row sage — *finished, nothing owed* —
 * while an agent it had delegated to was stopped waiting for an answer. That
 * was survivable while the child had a row of its own two lines below. Once
 * the child is hidden under it, this row is the only place that agent exists.
 *
 * `doing()` is still the right question for a *word* — "working", "your move".
 * This is the question for a colour, and for the order the list reads in.
 */
export function placeBeat(place: Workspace, places: Workspace[]): Beat {
  return BEAT[loudest(familyOf(place, places)).status];
}

/**
 * Every agent of the family that is stopped waiting for an answer.
 *
 * `NeedsYou` alone, not `needsYou`: the wider grouping covers finished and
 * broken as well, and neither of those has an answer to give. This is what the
 * peek offers buttons for, and what the lists count.
 */
export function asking(place: Workspace, places: Workspace[]): Session[] {
  return familyOf(place, places).filter((r) => r.status === "NeedsYou");
}

/**
 * How many agents across a fleet are stopped waiting for an answer.
 *
 * **Agents, not places**, and the whole list rather than the rows drawn from
 * it. It was `places.filter(p => p.runs.some(needsYou)).length`, which
 * under-counted a workspace holding two blocked runs — and once a delegated
 * child stopped having a row, counting the rows would have lost it entirely.
 *
 * `NeedsYou` alone: the wider `needsYou` covers finished and broken as well,
 * and this is the number that will one day set the app icon badge. A badge
 * counts questions, not checkouts.
 */
export function waitingAgents(places: Workspace[]): number {
  return places.flatMap((p) => p.runs).filter((r) => r.status === "NeedsYou").length;
}

/** When the family last moved. A row's age is the whole family's, so an idle
 *  parent does not read 3h while something under it moved a minute ago. */
export function lastMoved(runs: Session[]): string {
  return runs.reduce((latest, r) => (r.updatedAt > latest ? r.updatedAt : latest), runs[0]?.updatedAt ?? "");
}

/** What a parent row says about what it leads, in two slots. */
export type ChildLine = {
  /** `blocked` and `broken` take colour; `quiet` is everything else. */
  tone: "blocked" | "broken" | "quiet";
  /** The phrase, on the left. Gives way first. */
  text: string;
  /** How many it stands for, on the right. Never gives way — unless it is
   *  already the phrase, which is what `null` says. */
  count: string | null;
};

/**
 * The one line a parent row carries for its children: **the loudest true thing
 * about them**, and nothing else.
 *
 * It names the child when exactly one of them is blocked or broken and counts
 * them when more are — which one it is only matters for the two states
 * somebody has to act on. Three agents working is not a state to feel, so it
 * is said in dim and the colour budget stays where `STYLE.md` puts it.
 *
 * Eight children is a count and never a list. There is no width at which eight
 * names fit, and the row that tries is the row that drops the age.
 */
export function childLine(place: Workspace, places: Workspace[]): ChildLine | null {
  const kids = childrenElsewhere(place, places);
  if (kids.length === 0) return null;

  const beats = kids.map((kid) => placeBeat(kid, places));
  const of = (beat: Beat) => kids.filter((_, i) => beats[i] === beat);
  const blocked = of("blocked");
  const broken = of("broken");
  const working = of("working");
  const count = `${kids.length} ${kids.length === 1 ? "agent" : "agents"}`;
  const says = (tone: ChildLine["tone"], text: string): ChildLine => ({ tone, text, count });

  if (blocked.length === 1) return says("blocked", `${rowLabel(blocked[0], places)} is waiting on you`);
  if (blocked.length > 1) return says("blocked", `${blocked.length} waiting on you`);
  if (broken.length === 1) return says("broken", `${rowLabel(broken[0], places)} failed`);
  if (broken.length > 1) return says("broken", `${broken.length} failed`);
  if (working.length === kids.length) return says("quiet", kids.length === 1 ? "working" : "all working");
  if (working.length > 0) return says("quiet", `${working.length} working`);
  /* Nothing to report about them, so the count takes the line on its own
     rather than being stranded against the right edge with a blank beside it. */
  return { tone: "quiet", text: count, count: null };
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
 * This is also the lookup a tap on a team member ends in — a row names a
 * *session* and the phone has only a *workspace* route, so the route resolves
 * one to the other here rather than every caller doing it its own way. See
 * `opens` and `runAt`, which are the other two thirds of that.
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

/**
 * What a team row opens: the session it names, or nothing when it names the
 * one you are already reading.
 *
 * **One condition, because the desk has exactly one.**
 * `desktop/src/ui/OverviewTab.tsx` draws the active member as a plain row and
 * every other member as a link to `/sessions/<id>`. There is no resolution
 * step in front of it and no second test, and every extra test this has worn
 * was another way for a row naming a real session to go dead under a thumb:
 * a member whose workspace was filtered out of the list, one that has ended,
 * and — the case that killed every row in the panel — a subagent sharing the
 * manager's checkout, which resolves to the workspace you are standing in.
 *
 * So the row carries the **session** id, the same thing the desk links to,
 * and `runAt` is what the workspace route does with it on the other side.
 */
export function opens(member: Session, reading: Session): string | undefined {
  return member.id === reading.id ? undefined : member.id;
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
 * The run an address names, when it names one rather than the place itself.
 *
 * `placeOf` answers *which workspace*; this answers *whose transcript*, and
 * the pair is how one route does the work the desk needs two for. The desk
 * opens a team member at `/sessions/<id>` and shows that session. The phone
 * has `/workspace/<id>` and nothing else, so the address carries the run and
 * the screen follows it — which is what lets a subagent sharing the manager's
 * checkout open its own transcript rather than the page you are already on.
 *
 * `founder()` otherwise: an address that names the place is a request for the
 * place, and the run the place is named after is the one to read.
 *
 * **It was `lead()`, and that is what lit the wrong row in the Team panel.**
 * `lead()` answers *which run does this row describe* — the loudest one, so a
 * row's single dot and single line agree. Open a workspace whose subagent is
 * working and that is the subagent, so the panel marked the subagent's row as
 * where you are while the header above it carried the workspace's name, and
 * the parent's own row grew a chevron offering to open what was already
 * meant to be on screen. Which run is loudest is not who the place *is*.
 *
 * `lead()` stays as the last resort for a place with nothing in it to found
 * it, which `group()` cannot produce — the type wants a `Session` either way.
 */
export function runAt(place: Workspace, address: string): Session {
  return place.runs.find((r) => r.id === address) ?? founder(place) ?? lead(place);
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

/**
 * The same list, in that order. A copy: `sort` is in place and the caller's
 * array is memoised upstream.
 *
 * **On `placeBeat`, which is the family's, not `BEAT[lead(a).status]`.** Both
 * lists hide a delegated child under its lead, so a blocked child would
 * otherwise get *quieter* by being hidden: its own row is gone and its lead,
 * ranked on its own idle agents, sinks to the bottom with the finished ones.
 * It needs no new argument — the whole list is already what it is handed, and
 * the hiding happens after. **So hand it everything and filter after**, or
 * `familyOf` goes looking for children in a list they have been taken out of.
 */
export function ranked(places: Workspace[]): Workspace[] {
  return places.slice().sort((a, b) => RANK[placeBeat(a, places)] - RANK[placeBeat(b, places)]);
}
