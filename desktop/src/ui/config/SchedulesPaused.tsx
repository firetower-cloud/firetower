/**
 * What a save does to the schedules that pin this team.
 *
 * Saving the map re-pins the tree and withdraws every approval that named it,
 * so a person editing here can pause somebody else's unattended runs. That
 * has to be said **before** the commit, which is why this is mounted in the
 * map's action row beside Save rather than reported afterwards.
 *
 * **#493 owns the sentence**, and is shipping it as a component of its own so
 * that one fact has one wording. Until that lands this reads the count and
 * says nothing: a sentence written here would be the second wording, and two
 * of them is how a product ends up saying the same thing two ways.
 *
 * The swap is this file — one import and one return.
 */
export function SchedulesPaused({ count }: { count: number }) {
  /* Read, and deliberately silent. See above. */
  void count;
  return null;
}
