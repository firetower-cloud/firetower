/**
 * The arithmetic behind the skills sheet.
 *
 * **Ported from `desktop/src/skills.ts`, not re-derived — and the two copies
 * must not drift.** These are pure functions over the generated model, and
 * `mobile/src/api/workspaces.ts` states this repository's rule for exactly
 * this situation: a helper comes across with a comment saying where it came
 * from, and "when a third client wants any of it, extract the package the
 * README promises". Mobile is the second client, so it copies.
 *
 * What makes that cheap here and expensive if it is forgotten: `BUDGET` is the
 * number the meter in both sheets is drawn against. A per-agent token budget
 * that changes on one client and not the other means one of them draws a meter
 * that is wrong, and the failure is silent — a selection that fits on the desk
 * and is quietly dropped whole by the agent. `skills.test.ts` pins every value
 * in this file so a one-sided edit fails a build rather than shipping.
 *
 * The reciprocal note is at the top of `desktop/src/skills.ts`'s `BUDGET`.
 * Change one, change both, and move the numbers in the test with them.
 */

/**
 * Roughly what each agent will carry in descriptions, in tokens.
 *
 * **The number that matters is the cliff.** Past its budget Codex removes
 * *every* description rather than the last one, so a meter that only warned at
 * the end would warn too late. Codex states its own in
 * `skills.max_context_tokens`; 2,000 reconciles with `docs/skills.md` §3's
 * "about 8,000 characters" at roughly four characters a token.
 *
 * **Cursor is here because it was silently taking Claude Code's.** `Agent` has
 * five variants and this had three, so `BUDGET[agent] ?? 3000` gave a Cursor
 * session a 3,000 limit under a quiet meter. Cursor reads the same per-session
 * directory the others do and states no budget of its own, so it takes the
 * floor rather than the ceiling: being told you have less than you do costs a
 * skill, and being told you have more costs all of them.
 */
export const BUDGET: Record<string, number> = {
  ClaudeCode: 3000,
  Codex: 2000,
  KimiCode: 2250,
  CursorAgent: 2000,
};

/** The smallest budget anything could run under, for a profile that pins no
 *  agent — which is the honest figure to meter it against. */
export const SMALLEST_BUDGET = Math.min(...Object.values(BUDGET));

/** Whether two lists of ids hold the same set. */
export const sameSet = (a: Iterable<string>, b: Iterable<string>) => {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
};

/**
 * Where a session's selection came from, in a few words, or null when it is
 * not simply its defaults: `firetower defaults`, `defaults from 2 repos`.
 */
export function fromDefaults(
  selected: string[],
  repos: { slug: string; defaults: string[] }[],
  alwaysOn: string[],
): string | null {
  const giving = repos.filter((r) => r.defaults.length > 0);
  const expected = [...giving.flatMap((r) => r.defaults), ...alwaysOn];
  if (selected.length === 0 || expected.length === 0 || !sameSet(selected, expected)) return null;
  if (giving.length === 0) return "always on";
  if (giving.length === 1) return `${giving[0]!.slug.split("/").pop()} defaults`;
  return `defaults from ${giving.length} repos`;
}

/* ── what the phone needs and the desk gets from a hover ──────────────── */

/**
 * Whether the chip is drawn at all.
 *
 * `STYLE.md`: a control that does not know stays quiet. **A request that
 * failed is as much a not-knowing as one that has not landed** — the count
 * falls back to an empty list either way, and a chip reading "No skills" over
 * a session that is reading seven is a worse answer than no chip.
 */
export function chipShows(skills: { loading: boolean; error: string | null }): boolean {
  return !skills.loading && !skills.error;
}

/**
 * The chip's words, once [`chipShows`] says there are any.
 *
 * Zero is `No skills`, which is the one string that departs from the desk. A
 * digit with a noun after it reads as a count that broke, and the phone has
 * the room for the word.
 */
export function chipLabel(count: number): string {
  if (count === 0) return "No skills";
  return `${count} ${count === 1 ? "skill" : "skills"}`;
}

/** Two groups, by where a skill comes from — never by whether it is ticked.
 *  A row that moved when it was tapped would make a list of three hundred
 *  unusable, and on a phone it would move under the finger that tapped it. */
export type Group<T> = { at: "default" | "all"; title: string; rows: T[] };

export function groupSkills<T extends { id: string; name: string; description: string }>(
  all: T[],
  defaultsHere: Set<string>,
  query: string,
): Group<T>[] {
  const q = query.trim().toLowerCase();
  const match = (s: T) => !q || s.name.includes(q) || s.description.toLowerCase().includes(q);
  const rows = all.filter(match);
  return [
    { at: "default" as const, title: "Your defaults here", rows: rows.filter((s) => defaultsHere.has(s.id)) },
    { at: "all" as const, title: "All skills", rows: rows.filter((s) => !defaultsHere.has(s.id)) },
  ].filter((g) => g.rows.length > 0);
}

/**
 * Two skills of one name cannot both be on.
 *
 * The agent answers to the name and the folder on the worker *is* the name, so
 * two is ambiguous and only one could be written. The server refuses it — see
 * `choose_skills` — and saying so here is what stops somebody meeting that
 * refusal as a failed save. Returns the name that is doubled, or null.
 */
export function clashingName<T extends { id: string; name: string }>(
  all: T[],
  picked: Set<string>,
): string | null {
  const seen = new Set<string>();
  for (const s of all.filter((s) => picked.has(s.id))) {
    if (seen.has(s.name)) return s.name;
    seen.add(s.name);
  }
  return null;
}

/**
 * What a confirmation would do, and whether it may happen at all.
 *
 * Pulled out of the sheet because none of it can be reached by a test once it
 * is inside a component — `mobile/`'s vitest has no renderer — and because
 * every one of these answers is a sentence somebody reads before they commit
 * something that re-bills the whole conversation as uncached input.
 */
export function plan({
  all,
  picked,
  live,
  budget,
  repos,
  aimedAt,
  want,
}: {
  all: { id: string; name: string; tokens: number }[];
  picked: Set<string>;
  /** What the session is reading now. */
  live: string[];
  budget: number;
  repos: { repoId: string; slug: string; defaults: string[] }[];
  /** Which of the session's repositories the switch applies to. */
  aimedAt: Set<string>;
  /** The switch, `null` until it is touched so it can show what is already true. */
  want: boolean | null;
}) {
  const spend = all.filter((s) => picked.has(s.id)).reduce((n, s) => n + s.tokens, 0);
  const over = spend > budget;
  const clash = clashingName(all, picked);
  const added = [...picked].filter((id) => !live.includes(id));
  const gone = live.filter((id) => !picked.has(id));
  const dirty = added.length > 0 || gone.length > 0;

  const matching = repos.filter((r) => sameSet(r.defaults, picked));
  // Nothing ticked is not a selection to make the default.
  const already = picked.size > 0 && repos.length > 0 && matching.length === repos.length;
  const on = want ?? already;
  const aimed = repos.filter((r) => aimedAt.has(r.repoId));
  /* Turning it on makes each repository's defaults exactly the selection.
     Turning it off is just as explicit: these skills stop being defaults
     there, and whatever else was a default stays. */
  const setsDefaults = want === true && aimed.some((r) => !sameSet(r.defaults, picked));
  const clearsDefaults = want === false && aimed.some((r) => r.defaults.some((id) => picked.has(id)));
  const writesDefaults = setsDefaults || clearsDefaults;

  return {
    spend,
    over,
    clash,
    added: added.length,
    gone: gone.length,
    dirty,
    already,
    /** Where the switch sits right now. */
    on,
    aimed,
    setsDefaults,
    clearsDefaults,
    writesDefaults,
    /** Nothing may be sent: the server would refuse it, or the agent would drop it all. */
    blocked: over || clash !== null,
    /** There is nothing to send, so confirming is the same as closing. */
    nothingToDo: !dirty && !writesDefaults,
  };
}

/** The button's words. The count is on it because a flick dismisses this sheet
 *  like every other one in the app, and the commit should be hard to mistake. */
export function confirmLabel(p: {
  clash: string | null;
  over: boolean;
  dirty: boolean;
  writesDefaults: boolean;
  count: number;
}): string {
  if (p.clash || p.over) return "Can't confirm";
  if (p.dirty) return `Confirm ${p.count} ${p.count === 1 ? "skill" : "skills"}`;
  if (p.writesDefaults) return "Save";
  return "Confirm";
}
