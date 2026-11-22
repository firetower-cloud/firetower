/**
 * The team around a workspace, as deep as it actually goes.
 *
 * **It was one level.** `Workbench` built the Team panel's list as the
 * manager's *direct* children, so a team drawn three deep — a lead, an
 * engineer, and the two advisors the engineer started — showed four of its
 * six agents and gave no sign the other two existed. Reported from a real
 * run, where the agents that were missing were the ones doing the work.
 *
 * Nothing had to be fetched for this. Every session already carries its
 * `parentId`; the filter simply stopped at the first generation.
 *
 * ## Order is per sibling group, not global
 *
 * A flat sort by status would interleave generations — a grandchild that is
 * working would jump above the parent that started it, and the rail would
 * draw a child above its own manager. So each group of siblings is sorted on
 * its own and the tree order is kept: working first, then by name, among the
 * agents that actually share a parent.
 *
 * ## Depth is carried, not derived
 *
 * The panel draws a rail per level and stops indenting past {@link CAP} — a
 * six-deep team would otherwise spend half a 300px panel on indentation and
 * clip every name. The row needs to know how deep it is to do that, and
 * counting ancestors at render time would be the same walk done again.
 */
import type { Session } from "~/api/generated/model";

/** Working first, then what needs somebody, then the rest as they finish. */
const RANK: Record<string, number> = {
  Working: 0,
  Starting: 0,
  NeedsYou: 1,
  Ready: 2,
  HandedBack: 3,
  Failed: 4,
  Ended: 5,
};

/**
 * How many levels are drawn as indentation before the rail stops moving.
 *
 * Three, because `MAX_DEPTH` on a team is 6 and six rails is 78px of a panel
 * that is 300px wide with a name, an agent mark and an age already in it.
 * Past this the row says whose it is instead — the information survives and
 * the width does.
 */
export const CAP = 3;

/** One agent on the team, and how far under the manager it sits. */
export type Member = {
  session: Session;
  /** 1 for the manager's own children. */
  depth: number;
  /** What started it, where that is not the manager. For the rows past the
   *  cap, which say so rather than showing it. */
  under: string | null;
};

/**
 * Every agent under `managerId`, in tree order, each with its depth.
 *
 * Cycles cannot happen — a child's parent is set once, at spawn, to a session
 * that already exists — but a `seen` set costs nothing and a render loop is a
 * frozen window rather than a wrong number.
 */
export function teamUnder(sessions: Session[], managerId: string): Member[] {
  const byParent = new Map<string, Session[]>();
  for (const s of sessions) {
    if (!s.parentId) continue;
    const group = byParent.get(s.parentId);
    group ? group.push(s) : byParent.set(s.parentId, [s]);
  }
  for (const group of byParent.values()) {
    group.sort(
      (a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) || a.name.localeCompare(b.name),
    );
  }

  const out: Member[] = [];
  const seen = new Set<string>([managerId]);
  const walk = (parentId: string, depth: number, parentName: string | null) => {
    for (const s of byParent.get(parentId) ?? []) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      out.push({ session: s, depth, under: depth > CAP ? parentName : null });
      walk(s.id, depth + 1, s.name);
    }
  };
  walk(managerId, 1, null);
  return out;
}

/** How many of them are doing something right now. */
export function working(team: Member[]): number {
  return team.filter((m) => m.session.status === "Working" || m.session.status === "Starting")
    .length;
}
