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
 *
 * **The band is the one place this goes past the rail rather than porting
 * it.** `BANDS`, `ranked`'s comparator and `banded` are the desk's `BANDS`,
 * `worstFirst` and `Listing`; `bandOf` is new, and it is what the rail's
 * `doing(place)` should have been — see its docblock for the two gaps. It
 * belongs on the desk as well, which has both of them and the same hidden
 * children, but that is the desk's change to make and this does not assume
 * it. `useSettled` is the phone's alone: a pointer does not rest on a row.
 */

import { useEffect, useRef } from "react";

import type { Session } from "./generated/model";
import { beatOf, inFlight, needsYou, unrecognised, type Beat } from "./view";

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

/** What a place is doing, in one word: `doing()`'s answer, and a band's. */
export type Doing = "waiting" | "working" | "idle";

/**
 * What the place as a whole is doing.
 *
 * Not any one agent's status. `unfinished` is the wrong question here — it
 * means "still holds a host", so an idle workspace and a busy one both answer
 * yes, and everything reads as working.
 *
 * **Its own runs, and `inFlight` before `needsYou`. Both are deliberate and
 * both are wrong for a band** — see {@link bandOf}, which is a third function
 * rather than a change to this one. This answers *what is this place doing*
 * for a word on a row, where *working* is the more useful answer; a heading
 * with rows under it is a different question.
 */
export function doing(place: Workspace): Doing {
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
 *
 * **unknown** sits with the two that are at rest and above *done*, for the
 * same reason a failure does: nobody can say it is finished. It is not above
 * `working`, because a family with an agent actually typing in it is better
 * described by that than by a word the app could not read.
 */
const PRECEDENCE: Beat[] = ["blocked", "working", "broken", "unknown", "done", "over"];

/** The one of these whose beat comes first. Ties keep the order they arrived
 *  in, which is the place's own runs before anything it delegated.
 *
 *  `beatOf` rather than `BEAT[…]`: the table answers `undefined` for a status
 *  this app has never heard of, and `indexOf(undefined)` is `-1` — which
 *  sorts ahead of every real beat, so the one run nobody could read became
 *  the one the whole row was named after. */
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
  return beatOf(loudest(familyOf(place, places)));
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
 * The three bands a list reads under, and what each one is called.
 *
 * **The desk's own three words** — `desktop/src/ui/RailPanel.tsx:184` draws
 * exactly these — and not the owner's *working, waiting, done*. `doing()`
 * answers `idle` when nothing is in flight and nothing wants you, and most of
 * what lands there is `Ready`: up, idle, nothing owed either way. Calling
 * that *Done* claims a workspace finished something when it may have done
 * nothing at all. The work that genuinely finished is a hand-back, which is
 * under *Waiting on you* where your move is, or ended, which is filtered off
 * both lists before they get here.
 *
 * Sentence case, because `STYLE.md` allows roughly one tracked-out ALL-CAPS
 * legend per screen and this would be three.
 */
export const BANDS: Record<Doing, string> = {
  waiting: "Waiting on you",
  working: "Working",
  idle: "Idle",
};

/**
 * And the order they are drawn in: worst first.
 *
 * `Record<Doing, …>` for {@link RANK}'s reason — a fourth band is a build
 * error in both tables rather than a silent `undefined` in the comparator.
 */
const BAND_ORDER: Record<Doing, number> = { waiting: 0, working: 1, idle: 2 };

/**
 * Which band a row reads under. **The family's, and a person before a
 * machine.**
 *
 * `doing(place)` is the wrong reading twice over, and only one of the two
 * mistakes is about hidden children.
 *
 * - **It reads `place.runs`.** A parent that is `Ready` in every one of its
 *   own agents, with one blocked child under it, bands as *Idle* — while
 *   wearing the ember mark `placeBeat` gives it. A contradiction on the row,
 *   and a blocked agent filed under the one heading nobody reads when they
 *   are looking for work to do. The desk's rail has this gap today.
 * - **It tests `inFlight` first.** Widening it to the family is necessary and
 *   not sufficient: that precedence was written for a *word on a row*, and as
 *   a band it files the stuck agent under the typing one. {@link placeBeat}'s
 *   own docblock is the argument against it — *a sibling still working does
 *   not make an unanswered question any less unanswered.*
 *
 * So this is a third function and `doing()` is untouched: it still answers
 * the question it was written for, `lead()` still reads it, and nothing that
 * calls it moves.
 *
 * **What the swap buys is an invariant**, and the invariant is what the tests
 * hold: *no row's mark is louder than the band it sits under.* `placeBeat` is
 * `blocked` only when a run in the family is `NeedsYou` and `broken` only
 * when one is `Failed` — and both of those are in `NEEDS_YOU`, which is what
 * `needsYou` tests. So the first line here catches every row the second and
 * third could have filed too quietly, and ember and brick appear only under
 * *Waiting on you*. The reverse mismatch survives and should: a sage mark
 * under that heading is a hand-back, a slate one is a working family with a
 * failure in it. A quiet mark under a loud heading sends you to look at
 * something that genuinely wants you; a loud mark under a quiet heading loses
 * the agent.
 *
 * `places` is the whole fleet, for `familyOf`'s reason.
 */
export function bandOf(place: Workspace, places: Workspace[]): Doing {
  const family = familyOf(place, places);
  if (family.some(needsYou)) return "waiting";
  /* **An unrecognised status is not idle, and the three bands do not grow a
     fourth for it.** `needsYou` and `inFlight` are both lists of statuses
     this app knows, so a newer control plane's state answered no to both and
     fell through to the bottom of the list, under the one heading nobody
     reads when they are looking for work to do — which is the same way a
     hidden blocked child used to get lost, arriving from the API rather than
     from the tree.

     *Waiting on you* because somebody does have to look: the app cannot say
     what the state means, and that is a question for a person. The row's own
     mark stays quiet (`BEAT_TOKEN.unknown` is `mute`) and its label says the
     state is not known, so this is a quiet mark under a loud heading — the
     direction this file's own note says is the safe one. The reverse would
     lose the agent. */
  if (family.some(unrecognised)) return "waiting";
  if (family.some(inFlight)) return "working";
  return "idle";
}

/**
 * The order a list of workspaces reads in. **Not sections — an order.**
 *
 * Grouped is still the one not to ship: a workspace changes state while you
 * are looking at it, and the row you reached for would jump sections under
 * your thumb. What the bands add is a *label* where the order turns, which is
 * what the desk's rail has always drawn — see {@link banded}. No container,
 * nothing to collapse, and no row with a parent other than the scroll view it
 * was always in.
 *
 * `Record<Beat, …>` rather than `Record<string, …>`, so adding a beat is a
 * build error here instead of a silent `undefined` in the comparator, which
 * would sort the new one to an arbitrary place.
 *
 * Shared because two surfaces draw this list — the Workspaces destination and
 * the home's docked column, which is the same list previewed — and two copies
 * of a comparator are two chances to disagree about what comes first.
 */
export const RANK: Record<Beat, number> = {
  blocked: 0,
  broken: 1,
  /* With the two that want somebody, and above the ones at rest: a state the
     app cannot read is not a state it may file as finished. */
  unknown: 2,
  working: 3,
  done: 4,
  over: 5,
};

/**
 * The same list, in that order: **the band first, then the beat within it.**
 * A copy — `sort` is in place and the caller's array is memoised upstream.
 *
 * This is the desk's `worstFirst` (`RailPanel.tsx:196`) with {@link bandOf}
 * in place of `doing`. Band first is not a preference: it is what makes the
 * three bands *contiguous*, and non-contiguous bands mean the same label
 * drawn twice down one list. There is no version of labelling this list that
 * does not touch the sort.
 *
 * **Two kinds of row therefore move**, and somebody who knows this list will
 * see it. A family that is working with a failed agent in it rises above the
 * cleanly-working ones. And a handed-back workspace leaves the idle end of
 * the list for *Waiting on you*, which is a fix rather than a cost: a
 * hand-back used to sort beside a workspace where nothing is happening.
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
  return places
    .slice()
    .sort(
      (a, b) =>
        BAND_ORDER[bandOf(a, places)] - BAND_ORDER[bandOf(b, places)] ||
        RANK[placeBeat(a, places)] - RANK[placeBeat(b, places)],
    );
}

/** A row, and the band it is drawn under. */
export type BandedRow = {
  place: Workspace;
  /** Which band it sits in. */
  band: Doing;
  /**
   * The label to draw above it — set on the first row of each band and `null`
   * on every other row. That is what makes this a label where the band
   * *turns* rather than a section heading: there is nothing to put rows
   * *inside* of.
   */
  turn: { says: string; count: number } | null;
};

/**
 * Where the band turns, and how many rows each one holds.
 *
 * The count is **rows**, counted off the rows themselves: a count that does
 * not match what is under it is the "33 lines, 40 touched" lie, and a hidden
 * child has no row to be counted in. It cannot count agents either — a label
 * stands for a run of rows and has to say how many of those there are.
 *
 * An empty band is not *handled* here. It is undrawable: a band with no rows
 * in it has nothing to turn at. A fleet that is all one band still gets that
 * one label, because the first row always turns.
 */
function turns(rows: { place: Workspace; band: Doing }[]): BandedRow[] {
  const held = new Map<Doing, number>();
  for (const row of rows) held.set(row.band, (held.get(row.band) ?? 0) + 1);

  let last: Doing | null = null;
  return rows.map(({ place, band }) => {
    const turn = band === last ? null : { says: BANDS[band], count: held.get(band) ?? 0 };
    last = band;
    return { place, band, turn };
  });
}

/**
 * The rows to draw, banded. One list, in one order, with a label where the
 * band turns — the desk's `Listing` (`RailPanel.tsx:320`), whose own comment
 * says what this file's used to: *flat and ordered, not grouped into
 * sections.*
 *
 * **One argument, and it is the whole fleet, because that is the trap.** The
 * comparator and the labels have to be computed from the same list: hand the
 * comparator the rows a screen is drawing and `familyOf` finds no children
 * there, so the band a row was *sorted* by and the band its label is *drawn*
 * from disagree — and the same label draws twice down one list. Found in the
 * prototype, which did exactly that until it matched this. So the ranking,
 * the filter and the labels all happen in here, where a caller cannot get the
 * order of the three wrong.
 */
export function banded(every: Workspace[]): BandedRow[] {
  return turns(
    ranked(every)
      .filter((place) => !isChild(place, every))
      .map((place) => ({ place, band: bandOf(place, every) })),
  );
}

/** The live rows, in the order and under the bands they last settled in. */
function restack(live: BandedRow[], settled: BandedRow[]): BandedRow[] {
  const was = new Map(settled.map((row, at) => [row.place.id, { band: row.band, at }]));
  const kept = live.map((row, i) => {
    const seen = was.get(row.place.id);
    /* A row that arrived while the list was frozen has no settled position,
       so it joins the end of its own band rather than displacing a held one. */
    return { place: row.place, band: seen?.band ?? row.band, at: seen?.at ?? settled.length + i };
  });
  kept.sort((a, b) => BAND_ORDER[a.band] - BAND_ORDER[b.band] || a.at - b.at);
  return turns(kept);
}

/**
 * The order the list last settled in, for as long as a row is held.
 *
 * **The phone's one addition to the desk's design**, and the direct answer to
 * why this list refused status grouping for as long as it did: *the row you
 * reached for* must not move. The objection was never really about sections —
 * a flat list that re-sorts under a thumb is the same defect — and a fleet
 * refetch lands while a press is in flight often enough to matter.
 *
 * **Only the position is held. The row is never stale.** Every `place` here
 * is the live one, so a row that goes blocked under your thumb still turns
 * ember where it stands — under a heading that is now quieter than its mark,
 * for the second or two it is held. That mismatch is the visible evidence
 * that the list is holding still for you. Freezing a row's *contents* would
 * be the unsafe direction: a row that goes blocked and keeps drawing sage is
 * the one failure this whole change exists to prevent.
 *
 * The band is frozen alongside the order, and it has to be. A row held in
 * place while its own band changes would otherwise sit under the wrong
 * heading and split that band in two — which is the duplicate label again,
 * arriving by a different door. So a held row keeps the band it was ranked
 * by, and anything that arrives mid-freeze joins the end of its own band.
 *
 * `held` is the peek, which is what a press on a row becomes: `Peek` covers
 * the list with a scrim as it opens, so the window is a press and however
 * long it stays open — under a second in the common case. Let go and the new
 * order applies at once.
 *
 * **It has to be the *resolved* peek, not the selected id.** A peek whose
 * workspace ends elsewhere loses its sheet the way every conditional subview
 * does — it is unmounted, so its `onClose` never fires and the id stays set.
 * Held on the id, this then freezes the list for the rest of the screen's
 * life with nothing on screen to dismiss: a family that goes blocked
 * afterwards keeps its ember mark and sits under *Idle*, and the summary
 * above it says *none waiting*. Held on the row, the hold ends when the row
 * does. {@link useVanished} is the other half, and lets the selection go.
 */
export function useSettled(rows: BandedRow[], held: boolean): BandedRow[] {
  const settled = useRef(rows);
  useEffect(() => {
    if (!held) settled.current = rows;
  }, [held, rows]);
  return held ? restack(rows, settled.current) : rows;
}

/**
 * Let a selection go when the thing it named has gone.
 *
 * A screen holds the *id* of the row being peeked and resolves it against the
 * list on every render, because the list is the live one and the row is not a
 * copy of anything. So the sheet is a conditional subview, and a workspace
 * that ends elsewhere — from the desk, from another phone, by the agent
 * finishing — takes the sheet away by unmounting it rather than by closing
 * it. `onClose` is a callback of a dismissal and there was no dismissal.
 *
 * What is left is a screen holding a selection that names nothing, which is
 * not merely untidy: it is what {@link useSettled} was reading, and a freeze
 * with no peek to end it does not end. Reachable by one ordinary gesture —
 * hold a row, have that workspace end elsewhere — and it was.
 *
 * Both screens call this, because both have the same two states and the same
 * sheet. `release` is a `useCallback` at each call site: this runs on every
 * render that resolves to nothing, and it is `setPeeking(null)` either way.
 */
export function useVanished(selected: string | null, found: Workspace | null, release: () => void) {
  useEffect(() => {
    if (selected !== null && !found) release();
  }, [selected, found, release]);
}

/**
 * The line above the list, which now says only what no band can say.
 *
 * It read *3 waiting on you · 14 in all*, three lines above a label reading
 * *Waiting on you · 3* — two sizes of the same claim, and the one in the
 * smaller type is the one with the hairline and the rows under it.
 *
 * Worse than repetition: **the two numbers disagree in both directions.**
 * `waitingAgents` counts *agents* that are `NeedsYou`; a band counts *rows*,
 * and a row can be banded for a `Failed` or `HandedBack` agent that is asking
 * nothing. Three rows, two questions — or two rows, three questions, with two
 * of them in one family. Neither number is wrong; printing both three lines
 * apart with no word to tell them apart is.
 *
 * So the clause goes while a *Waiting on you* label is drawn, and what stays
 * is the fleet: **every workspace, children included**, because that many
 * checkouts hold that many hosts and ending a parent ends what it started.
 * **The clause comes back when nothing is waiting**, because then there is no
 * label to say it and an absence is not a statement — and that branch is the
 * copy that ships today, unchanged.
 *
 * Handed the rows that are actually drawn, so the line and the labels cannot
 * disagree — including while {@link useSettled} is holding the order.
 *
 * **And handed the fleet, so a held order cannot make it lie.** The clause is
 * an absence — *none waiting* — and the one thing a frozen list cannot be
 * trusted about is what has happened since it froze. A family that goes
 * blocked during a hold has no `waiting` row to be read off `rows`, because
 * the bands in `rows` are the settled ones; the line would then print *none
 * waiting* over a row wearing an ember mark, which is the only surface on
 * this phone where a blocked agent is visible at all. So the absence is
 * derived from live state and the label from the drawn rows, and the clause
 * goes if **either** says there is something waiting.
 *
 * Live state is the *family's*, which is what a band is: a run that needs you
 * is in some place's runs, and that place's family is in some drawn row's —
 * so asking the whole fleet is exactly asking whether any row bands as
 * waiting, without having to re-rank anything to find out.
 */
export function fleetLine(every: Workspace[], rows: BandedRow[]): string {
  const labelled = rows.some((row) => row.band === "waiting");
  const live = every.some((place) => place.runs.some(needsYou));
  /* **And nothing unreadable, either.** *None waiting* is an absence, and an
     absence is only true of states this app can read. A status it has never
     heard of answers no to `needsYou` by not being in a list — so the one
     session whose meaning nobody could work out was also the one the line
     counted as nothing. It cannot be claimed as waiting either; what it can
     do is stop the claim that nothing is. */
  const unreadable = every.some((place) => place.runs.some(unrecognised));
  return labelled || live || unreadable
    ? `${every.length} in all`
    : `${every.length} in all, none waiting`;
}
