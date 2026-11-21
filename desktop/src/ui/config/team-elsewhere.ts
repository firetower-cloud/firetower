/**
 * The fields this screen draws that another branch owns.
 *
 * Three requirements land on the map and none of them is written on #492:
 * the schedules a save would pause (#493), the seats a spawn added on its own
 * (#491), and the per-seat timestamp that marks them. Each is a field on a
 * response this screen already fetches — no extra request, and each is known
 * before anything is committed.
 *
 * **They are read here and nowhere else**, through functions that answer a
 * sensible number when the field is not there yet. That keeps the map honest
 * against both the branch it stacks on, where the fields are absent, and the
 * branches that add them, where they are not. When those land, the field
 * names below are the only thing to check, and `team-elsewhere.test.ts` fails
 * if a reader starts lying.
 *
 * The parameters are the generated types, and the shapes below are what each
 * reader looks for inside one. A field that does not exist yet cannot be
 * named in a type that does not have it, which is what the one cast in each
 * reader is for — and why there is exactly one place to look when it does.
 */

/** What #493 adds to a team, and #491 adds to a team and to a seat. */
type TeamElsewhere = {
  /** Approved schedules pinning this team, across every owner. */
  schedules?: number | null;
  /** Seats added by a hand-off rather than by somebody. */
  autoAdded?: number | null;
};

type SeatElsewhere = {
  /** When a hand-off added this seat, or absent when somebody placed it. */
  autoAddedAt?: string | null;
};

/**
 * How many approved schedules a save would pause.
 *
 * **A property of the team, not of the draft.** Any save re-pins the tree and
 * withdraws every approval that named it, so the number does not depend on
 * what was changed and is not recomputed as somebody edits.
 */
export function schedulesPinning(team: object | undefined | null): number {
  return Math.max(0, (team as TeamElsewhere | null | undefined)?.schedules ?? 0);
}

/**
 * Whether a hand-off put this seat here rather than a person.
 *
 * The timestamp is the fact; this screen only asks whether there is one.
 */
export function arrivedOnItsOwn(seat: object | undefined | null): boolean {
  return !!(seat as SeatElsewhere | null | undefined)?.autoAddedAt;
}

/**
 * How many seats arrived on their own.
 *
 * Counted off the seats where there are seats to count — the map holds the
 * whole tree, so it can be exact — and read off the team where there are not,
 * which is the list, one row per team and no tree in hand.
 */
export function autoAddedCount(team: object | undefined | null, seats?: object[]): number {
  if (seats) return seats.filter(arrivedOnItsOwn).length;
  return Math.max(0, (team as TeamElsewhere | null | undefined)?.autoAdded ?? 0);
}
