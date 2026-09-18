/**
 * What the island is told.
 *
 * The island holds no token, opens no socket and asks no server anything. The
 * main window already has every backend on one poll (`fleet.ts`) and already
 * pays for the connections; `src/api/events.ts` records what happened the last
 * time two things in this app polled the same servers independently, and a
 * second webview with its own streams would be that again with a worse excuse.
 *
 * So this file is the wire format, and it is derived in the window that has the
 * data and consumed in the one that does not. Flat, already sorted, already
 * counted — everything the pill needs and nothing it would have to ask about.
 */
import type { Agent, Session, SessionStatus } from "~/api/generated/model";
import { minutesSince, needsYou } from "~/api/view";
import { doing, group, shortRepo, type Workspace } from "~/api/workspaces";
import type { Fleet } from "~/fleet";

/** One workspace, as a row on the pill. */
export type Row = {
  /** Unique across servers: the same workspace id on two backends is two rows. */
  key: string;
  serverId: string;
  workspaceId: string;
  /** The server's monogram. Identity is a shape here, exactly as it is in the app. */
  mark: string;
  name: string;
  repo: string;
  agent: Agent;
  status: SessionStatus;
  minutes: number;
  /** From a server that is not answering. Shown, and shown to be old. */
  stale: boolean;
};

export type IslandState = {
  waiting: Row[];
  working: Row[];
  /** How many backends are connected, and how many of them are dark. */
  servers: number;
  unreachable: number;
};

export const empty: IslandState = { waiting: [], working: [], servers: 0, unreachable: 0 };

/**
 * Which of the three the pill is in.
 *
 * `demand` is the only one allowed to be ember, and it is the only one that is
 * ember anywhere in the app. The ladder is the whole design: nothing to say,
 * something happening, something waiting.
 */
export type Mode = "dormant" | "ambient" | "demand";

export function modeOf(state: IslandState): Mode {
  if (state.waiting.length > 0) return "demand";
  if (state.working.length > 0) return "ambient";
  return "dormant";
}

/** The one session in a workspace that the row is about. */
function lead(place: Workspace, waiting: boolean): Session {
  return (waiting ? place.runs.find(needsYou) : place.runs.find((r) => !needsYou(r))) ?? place.runs[0];
}

/**
 * Every server's fleet, flattened into two lists.
 *
 * Ordered the way the app orders it — newest first — rather than by how long
 * something has been waiting, which is the more tempting sort and the wrong
 * one. `Fleet.tsx` warns that a second way of drawing the same fleet is how two
 * screens drift apart, and the island is a third screen showing the same rows.
 */
export function islandState(fleet: Fleet[]): IslandState {
  const waiting: Row[] = [];
  const working: Row[] = [];

  for (const { backend, sessions } of fleet) {
    const live = sessions.filter((s) => s.status !== "Ended");
    for (const [repo, places] of group(live).groups) {
      for (const place of places) {
        const state = doing(place);
        if (state === "idle") continue;

        const isWaiting = state === "waiting";
        const run = lead(place, isWaiting);
        const row: Row = {
          key: `${backend.id}:${place.id}`,
          serverId: backend.id,
          workspaceId: place.id,
          mark: backend.mark,
          name: place.name,
          repo: shortRepo(repo),
          agent: run.agent,
          status: run.status,
          minutes: minutesSince(run.createdAt),
          stale: backend.reach === "unreachable",
        };
        (isWaiting ? waiting : working).push(row);
      }
    }
  }

  const newestFirst = (a: Row, b: Row) => a.minutes - b.minutes;
  waiting.sort(newestFirst);
  working.sort(newestFirst);

  return {
    waiting,
    working,
    servers: fleet.length,
    unreachable: fleet.filter((f) => f.backend.reach === "unreachable").length,
  };
}

/**
 * Whether the island is on screen at all.
 *
 * "Hide until something needs you" is a choice about the quiet states, not an
 * off switch, and the difference matters enough to be a function of its own:
 * ember always wins. Somebody who hides the island on a Tuesday must not
 * discover on Thursday that they also turned off the one thing it is for.
 */
export function onScreen(quiet: boolean, mode: Mode): boolean {
  return !quiet || mode === "demand";
}

/** What the collapsed pill says, in one line. */
export function headline(state: IslandState): string {
  if (state.waiting.length > 0) {
    const [first] = state.waiting;
    return state.waiting.length === 1 ? first.name : `${state.waiting.length} waiting`;
  }
  if (state.working.length > 0) {
    return state.working.length === 1 ? state.working[0].name : `${state.working.length} running`;
  }
  return "";
}
