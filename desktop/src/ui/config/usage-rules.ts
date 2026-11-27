/**
 * What the agents spent, and on what — the rules, with no React in them.
 *
 * Everything on the Usage pane that can be decided without a DOM lives here,
 * so it can be asserted directly rather than read back out of markup: the
 * vocabulary the ledger is cut by, the number formats, what a window of a
 * subscription is called, which hue a model wears, and — the one that matters
 * most — **where a hue may appear at all**.
 *
 * The pane itself is `config/Usage.tsx`. Nothing here imports it — and the
 * file is `usage-rules` rather than `usage` only because a case-insensitive
 * filesystem cannot hold `Usage.tsx` and `usage.ts` side by side.
 */
import type {
  ConsumptionParams,
  Directory,
  Group,
  Limit,
  Sort,
  Totals,
} from "~/api/generated/model";

/* ── where a series hue may appear ───────────────────────────────────────
   This is the decision that blocked the port for the whole programme, and it
   is the first thing in the file because it is the thing most easily lost.

   `--color-series-1` to `-4` have existed since the consumption screen was
   written and `STYLE.md`'s namespace table did not mention them. They are a
   fourth namespace now, and the exception they are granted is **not** the one
   syntax has. Syntax earns its exception by *where it is* — never at page
   level, so it cannot compete with ember. A chart cannot earn it that way: a
   chart *is* at page level, at the top of a pane, in a window whose rail can
   carry an ember dot at the same moment.

   So the exception is granted on a containment rule instead, and this is the
   half of it that lives in code. See `STYLE.md`, *A chart is the second
   exception, and it is contained differently*, for the other three rules. */

/**
 * The three frames a series hue may appear inside, and nowhere else.
 *
 * Each is the `data-testid` of exactly one element, and the rule reads off the
 * DOM: **the string `--color-series-` appears in the rendered pane only inside
 * `usage-chart`, `usage-key` and `usage-tip`.** That is the containment rule
 * made testable and it is the one thing that fails first if the screen drifts
 * back to what the web ships — where the same four hues are also on the
 * stacked meter of every one of twenty-five ledger rows.
 *
 * Widening this list is a design decision somebody has to take out loud. It is
 * not a way to make a failing check pass.
 */
export const SERIES_FRAMES = ["usage-chart", "usage-key", "usage-tip"] as const;

export type SeriesFrame = (typeof SERIES_FRAMES)[number];

/** Which hue a model wears, decided once per page and kept. */
const SERIES = [
  "var(--color-series-1)",
  "var(--color-series-2)",
  "var(--color-series-3)",
  "var(--color-series-4)",
];

/**
 * Past four, the tail folds rather than taking a fifth hue.
 *
 * A fold is a shape decision; a fifth hue would be a new hue, and it would
 * have to clear the same gate the four did — quieter than ember, louder than
 * the file kinds.
 */
const FOLDED = "var(--color-mute)";

/**
 * A hue function and the id of the frame it is allowed to paint, together.
 *
 * **They are returned as a pair on purpose.** There is no way to get a series
 * hue without naming which of the three frames you are inside, and the name
 * you give is the `data-testid` that goes on that frame — so the only way to
 * paint a fourth thing is to either claim a frame you are not inside, which
 * the DOM check catches, or to add yourself to `SERIES_FRAMES`, which is not
 * something that slips through a diff.
 *
 * `order` is every model on the page, ranked by what it did over the whole
 * period rather than within a bucket. One order for the page is what stops the
 * stack reshuffling from one column to the next, and it means a filter that
 * drops a model never repaints the ones that are left.
 */
export function seriesIn(
  frame: SeriesFrame,
  order: string[],
): { testId: SeriesFrame; hue: (model: string) => string } {
  const rank = new Map(order.map((m, i) => [m, i]));
  return {
    testId: frame,
    hue: (model) => {
      const at = rank.get(model);
      return at !== undefined && at < SERIES.length ? SERIES[at] : FOLDED;
    },
  };
}

/**
 * What a ledger row's meter is filled with: one neutral length, always.
 *
 * The change that makes rule 1 true rather than aspirational. The web stacks
 * up to four hues here, on every row — which is the mapping leaving the chart
 * and tiling the page. The split is not lost: it is on the row's own hover
 * (`usage-tip`, which is a frame) and under *then by model*, which is a
 * first-class control.
 */
export const METER_FILL = "var(--color-dim)";

/* ── the vocabulary ──────────────────────────────────────────────────── */

/**
 * The three periods, and what a column of the chart is for each.
 *
 * Labels are the segment's own words rather than the web's sentence fragments
 * — *14 days*, not *the last 14 days* — because the control is three visible
 * segments here instead of one word that cycles.
 */
export const RANGES = {
  d14: { label: "14 days", days: 14, bucket: "day" },
  d90: { label: "90 days", days: 90, bucket: "week" },
  m12: { label: "12 months", days: 365, bucket: "month" },
} as const;

export type RangeKey = keyof typeof RANGES;

export const GROUPS = {
  task: "task",
  agent: "agent",
  model: "model",
  person: "person",
  repository: "repository",
  directory: "directory",
  subscription: "subscription",
  workspace: "workspace",
} as const;

export type GroupKey = keyof typeof GROUPS;

/** What "breadth" counts, for each way of grouping. */
export const BREADTH: Record<GroupKey, string> = {
  task: "workspaces",
  person: "tasks",
  agent: "people",
  model: "people",
  subscription: "people",
  repository: "tasks",
  directory: "tasks",
  workspace: "turns",
};

/** Where a list is long enough that finding beats ranking. */
export const SEARCHABLE: GroupKey[] = ["task", "workspace"];

/**
 * How to order the ledger: **one control saying one sentence**.
 *
 * The web splits this into a menu naming the field and a pill reading `DESC`
 * or `ASC`. Two problems, and folding them fixes both: tracked-out capitals
 * are banned on the desk, and both halves said a direction with no telling
 * which one won — the menu's *most recent* beside the pill's `ASC` is a
 * control arguing with itself.
 *
 * `__` is where the breadth pair takes the grouping's own noun, because a task
 * sprawling across worktrees and a model reaching people are both breadth and
 * neither is the other's column.
 */
export const SORTS = [
  { key: "tokens:desc", says: "most tokens first" },
  { key: "tokens:asc", says: "fewest tokens first" },
  { key: "recent:desc", says: "most recent first" },
  { key: "recent:asc", says: "oldest first" },
  { key: "breadth:desc", says: "most __ first" },
  { key: "breadth:asc", says: "fewest __ first" },
  { key: "name:asc", says: "A to Z" },
  { key: "name:desc", says: "Z to A" },
] as const;

export type SortKey = (typeof SORTS)[number]["key"];

/** The sentence one sort makes, for this grouping. */
export function sortSay(key: SortKey, by: GroupKey): string {
  const found = SORTS.find((s) => s.key === key) ?? SORTS[0];
  return found.says.replace("__", BREADTH[by]);
}

/** The two query parameters one sentence is. */
export function splitSort(key: SortKey): { sort: Sort; direction: "asc" | "desc" } {
  const [sort, direction] = key.split(":");
  return { sort: sort as Sort, direction: direction as "asc" | "desc" };
}

/* ── numbers people read ─────────────────────────────────────────────── */

/**
 * Billed tokens, abbreviated — `3.3M`, `215.5K`, `112K`.
 *
 * Exactly the web's, which is also what the headline, the ledger's figures and
 * the tooltip all use. The composition breakdown deliberately does not: the
 * point of those four numbers is that `4` and `29,176` are not the same kind
 * of thing, which `29.2K` beside `4` hides exactly.
 */
export function tokensText(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
  return `${Math.round(n)}`;
}

export const count = (n: number) => n.toLocaleString("en-US");

/**
 * A share of a quota, to a tenth where there is one.
 *
 * `1%` rather than `1.0%`, because a decimal that is always zero is a decimal
 * nobody reads — but `1.5%` kept, because at the start of a cycle that is the
 * only digit moving. Only Kimi reports a fraction at all.
 */
export function percent(n: number): string {
  const tenth = Math.round(n * 10) / 10;
  return `${Number.isInteger(tenth) ? tenth : tenth.toFixed(1)}%`;
}

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${count(n)} ${n === 1 ? one : many}`;

/**
 * A part of a whole, with the rounding kept away from both ends.
 *
 * A part that is there at all does not read as `0%`, and one that is short of
 * everything does not read as `100%` — either would deny what the breakdown is
 * for.
 */
export function share(n: number, of: number): string {
  if (of <= 0 || n === 0) return "";
  const pct = (n / of) * 100;
  if (pct < 1) return "<1%";
  if (pct > 99 && n < of) return ">99%";
  return `${Math.round(pct)}%`;
}

/**
 * Turns, which has no column of its own: the unit, and how many each took.
 *
 * One decimal below ten, because 1.4 and 2.3 are different kinds of session
 * and "2 each" would be the same sentence for both.
 */
export function perConversation(t: Totals): string {
  if (!t.conversations) return `${plural(t.turns, "turn")}.`;
  const each = t.turns / t.conversations;
  const said = each < 10 ? (Math.round(each * 10) / 10).toString() : Math.round(each).toString();
  return `${plural(t.turns, "turn")}, about ${said} each.`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type Bucket = (typeof RANGES)[RangeKey]["bucket"];

/** What the axis has room for under a column. */
export function columnLabel(iso: string, bucket: Bucket): string {
  const d = new Date(iso);
  if (bucket === "month") return MONTHS[d.getMonth()];
  return `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, "0")}`;
}

/** What the axis has no room to say: the year, and which week it is. */
export function columnFull(iso: string, bucket: Bucket): string {
  const d = new Date(iso);
  if (bucket === "month") return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  if (bucket === "week") return `Week of ${columnLabel(iso, bucket)}`;
  return columnLabel(iso, bucket);
}

/**
 * The period being asked about, rounded to the day.
 *
 * Rounded so the query key is stable across renders — otherwise every tick of
 * the clock is a new request for the same answer.
 */
export function periodOf(range: RangeKey, now: Date): { from: string; to: string } {
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  const start = new Date(end);
  start.setDate(start.getDate() - (RANGES[range].days - 1));
  start.setHours(0, 0, 0, 0);
  return { from: start.toISOString(), to: end.toISOString() };
}

/* ── which of four ways the pane is drawn while a read is in flight ──── */

/**
 * Four states, and they differ in **what is replaced** rather than in how
 * loud the spinner is.
 *
 * - `settling` — nothing has arrived. Skeletons at the real geometry, and no
 *   axis, no gridline and no zero: *nothing may draw a chart with no data in
 *   it.*
 * - `stale` — the period or the scope changed. The reading is replaced,
 *   because the control above already says the new period and a chart of the
 *   old one under it is a lie rather than a stale answer. The ledger keeps
 *   its rows, dimmed, because they are still the rows of the period they
 *   were read for.
 * - `refetching` — the sort, the grouping or the search changed. The chart
 *   and the figures do not depend on any of those, so nothing is replaced
 *   and nothing moves; the pane dims.
 * - `ready` — the answer on screen is the answer that was asked for.
 *
 * A rule rather than three expressions inline, because getting the third one
 * wrong is invisible: a pane that replaces the chart on every sort looks like
 * a pane that is working.
 */
export type ReadState = "settling" | "stale" | "refetching" | "ready";

export function readState(q: {
  /** No answer at all yet. */
  pending: boolean;
  /** A request is in flight. */
  fetching: boolean;
  /** There is an answer on screen, even if it is the previous one. */
  has: boolean;
  /** What the answer on screen was asked for. */
  showing: string;
  /** What the controls are asking for now. */
  wants: string;
}): ReadState {
  if (q.pending) return "settling";
  if (!q.fetching) return "ready";
  return q.has && q.showing !== q.wants ? "stale" : "refetching";
}

/* ── the ledger ──────────────────────────────────────────────────────── */

/** The sub-line under a row, in the terms that dimension is actually about. */
export function detail(g: Group, by: GroupKey): string {
  switch (by) {
    case "task":
      return `${plural(g.workspaces, "workspace")}, ${plural(g.conversations, "conversation")}`;
    case "person":
      return `${plural(g.tasks, "task")}, ${plural(g.conversations, "conversation")}`;
    case "model":
    case "subscription":
      return `${plural(g.people, "person", "people")}, ${plural(g.turns, "turn")}`;
    case "workspace":
      return plural(g.turns, "turn");
    default:
      return `${plural(g.tasks, "task")}, ${plural(g.people, "person", "people")}`;
  }
}

/**
 * What to call a row the data could not name.
 *
 * A task with a key and no name is one whose title did not come back; a task
 * with neither is work that was not filed against one. They are different
 * facts and the page says which.
 */
export function unnamed(g: Group, by: GroupKey): string {
  if (by === "task") return g.key ? "Title unavailable" : "No task assigned";
  if (by === "subscription") return "No subscription";
  return g.key ?? "Unknown";
}

/** The key a row and everything hanging off it is named by. */
export const rowKey = (g: Group) => g.key ?? "none";

/**
 * How long a row's meter is.
 *
 * The scale is the largest row on screen. Children scale against their
 * siblings but never reach the parent's length — a child as long as its parent
 * reads as equal to it — and nothing is shorter than 4%, or a row that did
 * something reads as a row that did nothing.
 */
export function meterWidth(tokens: number, scale: number, nested: boolean): number {
  const span = nested ? 68 : 100;
  return Math.min(span, Math.max(4, (tokens / scale) * span));
}

/** A nice round ceiling that halves cleanly, so the two gridlines read. */
export function ceiling(v: number): number {
  if (!v) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const s of [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10]) if (v <= s * p) return s * p;
  return 10 * p;
}

/**
 * Every model on the page, by what it did over the whole period.
 *
 * The server orders each bucket's models by what they did *in that bucket*,
 * which is right for a list and wrong for a stack: the segments would
 * reshuffle from one column to the next and the chart would read as noise.
 */
export function modelsByWeight(series: { models: { model: string; tokens: number }[] }[]): string[] {
  const seen = new Map<string, number>();
  for (const column of series)
    for (const m of column.models) seen.set(m.model, (seen.get(m.model) ?? 0) + m.tokens);
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
}

/** One bucket or one group's models, in the page's order, with the zeroes out. */
export function liveModels<T extends { model: string; tokens: number }>(
  list: T[],
  order: string[],
): T[] {
  const rank = new Map(order.map((m, i) => [m, i]));
  return [...list]
    .filter((m) => m.tokens > 0)
    .sort((a, b) => (rank.get(a.model) ?? 99) - (rank.get(b.model) ?? 99));
}

/* ── the scope ───────────────────────────────────────────────────────── */

export type Scope =
  | { kind: "all" }
  | { kind: "me" }
  | { kind: "team"; id: string; name: string }
  | { kind: "person"; id: string; name: string };

/**
 * What the scope control says it is showing.
 *
 * Not "everyone in the organisation": the rows underneath are already filtered
 * to what this person was granted, so promising more would be a lie on any
 * account that has less.
 */
export function scopeName(scope: Scope): string {
  if (scope.kind === "me") return "Just me";
  if (scope.kind === "team" || scope.kind === "person") return scope.name;
  return "Everyone I can see";
}

/**
 * Whether the scope control has anywhere to go — **and it is not a permission**.
 *
 * Consumption has no role gate on the server. What it has is a reach: every
 * read underneath is narrowed to the paths this person can see, which are
 * their own root plus any directory they hold a grant in (`reachable()` in
 * `crates/ft-server/src/access.rs`, and there is no administrator bypass in
 * it). Somebody holding no directory grant can therefore only ever see their
 * own work, and *Everyone I can see* and *Just me* name the same rows.
 *
 * **A menu whose every row means the same thing is a greyed control in a
 * different costume**, so the control becomes a sentence instead and says why.
 * Not disabled, not hidden behind a role — `config/Teams.tsx`' rule.
 *
 * `level` is this person's own grant, and an administrator is listed into
 * directories they have no grant in with `level` absent — which is the case
 * this has to read rather than counting rows.
 */
export function scopeIsFixed(directories: Directory[]): boolean {
  return !directories.some((d) => !!d.level);
}

/** Everybody and every team the picker offers, narrowed by what was typed. */
export function scopeMatches<T extends { id: string; name: string }, P extends { id: string; username: string }>(
  typed: string,
  teams: T[],
  colleagues: P[],
): { wide: { id: string; label: string; scope: Scope }[]; teams: T[]; people: P[] } {
  const needle = typed.trim().toLowerCase();
  const hits = (s: string) => !needle || s.toLowerCase().includes(needle);
  return {
    wide: [
      ...(hits("everyone") ? [{ id: "all", label: "Everyone", scope: { kind: "all" } as Scope }] : []),
      ...(hits("just me") ? [{ id: "me", label: "Just me", scope: { kind: "me" } as Scope }] : []),
    ],
    teams: teams.filter((t) => hits(t.name)),
    people: colleagues.filter((c) => hits(c.username)),
  };
}

/**
 * The whole request, from the state of the controls.
 *
 * **One function rather than seven spreads at the call site**, because the
 * query key *is* the request: a control that is drawn and not folded in here
 * narrows nothing, and the pane would still look like it was working. It is
 * also the only way the wiring can be asserted without a browser to press
 * anything in — `usage.test.tsx` reads the key back off the cache and
 * compares it with this.
 *
 * **`person: "me"` rather than the signed-in id**, which is the server's own
 * spelling: a link somebody shares should not quietly show them whoever sent
 * it.
 *
 * Absent rather than empty, throughout. `find=""` on the wire is a different
 * request from no `find` at all, and a `then` equal to the first level is a
 * second level that cuts nothing.
 */
export function consumptionAsk(a: {
  range: RangeKey;
  group: GroupKey;
  then: GroupKey | "";
  scope: Scope;
  sort: SortKey;
  /** What has settled after the typing stopped, not what is in the field. */
  find: string;
  limit: number;
  now: Date;
}): ConsumptionParams {
  const { from, to } = periodOf(a.range, a.now);
  const order = splitSort(a.sort);
  const narrowed = a.find.trim();
  return {
    from,
    to,
    bucket: RANGES[a.range].bucket,
    group: a.group,
    ...(a.then && a.then !== a.group ? { then: a.then } : {}),
    ...(a.scope.kind === "me" ? { person: "me" } : {}),
    ...(a.scope.kind === "person" ? { person: a.scope.id } : {}),
    ...(a.scope.kind === "team" ? { team: a.scope.id } : {}),
    sort: order.sort,
    direction: order.direction,
    limit: a.limit,
    ...(narrowed ? { find: narrowed } : {}),
  };
}

/* ── limits ──────────────────────────────────────────────────────────── */

/**
 * How full a window is, for ordering.
 *
 * A blocked window with no percentage is counted as full, because it is: the
 * provider has stopped answering. Anything else without a number has none —
 * Claude Code reports no percentage at all — and sorts last either way rather
 * than being called empty, which would put "we do not know" at the top of
 * "least used".
 */
export function fullness(l: Limit): number | null {
  if (l.usedPercent != null) return l.usedPercent;
  return l.status === "blocked" || l.status === "rejected" ? 100 : null;
}

/** The fullest window an account has, which is what ranks it against others. */
export function peak(limits: Limit[]): number | null {
  const known = limits.map(fullness).filter((n): n is number => n != null);
  return known.length ? Math.max(...known) : null;
}

/** Windows inside one account, ordered the way the accounts are. */
export function fuller(a: Limit, b: Limit, order: "asc" | "desc"): number {
  const x = fullness(a);
  const y = fullness(b);
  if (x == null && y == null) return 0;
  if (x == null) return 1;
  if (y == null) return -1;
  return order === "desc" ? y - x : x - y;
}

/**
 * What colour a window is, and why it is the percentage that decides.
 *
 * A provider says `allowed` right up until it says `blocked` — that is what the
 * word means — so colouring by status drew a bar at 94% in green and one at 79%
 * in red, which is the opposite of useful. Where there is a number, the number
 * decides, because the number is what is on screen. The word only gets a say
 * when it is the only thing we were told.
 *
 * **These are signals, not series.** Sage, amber and brick mean *how it is
 * going*; the chart's hues mean *which of these*. One screen may hold both —
 * they are told apart by position and shape, and they are a whole ledger
 * apart, which is why Limits goes last.
 */
export function tone(l: Limit): "sage" | "amber" | "brick" {
  if (l.status === "blocked" || l.status === "rejected") return "brick";
  if (l.usedPercent != null) {
    return l.usedPercent >= 90 ? "brick" : l.usedPercent >= 75 ? "amber" : "sage";
  }
  return l.status === "allowed" ? "sage" : "amber";
}

/**
 * Every spelling providers actually use for a window, mapped to one wording.
 *
 * Claude says `five_hour` and Codex says `5_hour` for the same five hours,
 * which read as "5-hour window" and "5 hour" side by side on one screen — two
 * different things, as far as anybody looking could tell.
 */
const WINDOWS: Record<string, string> = {
  five_hour: "5-hour window",
  "5_hour": "5-hour window",
  seven_day: "7-day window",
  "7_day": "7-day window",
  month: "this month",
  // Kimi meters coding separately from the rest of the plan, and says so.
  month_code: "this month, coding",
  account: "this account",
};

/**
 * What a window is called, including ones nobody has seen yet.
 *
 * Providers meter per model as well as per period — Claude Code's own binary
 * knows `seven_day_opus` — and none has appeared on the wire here, but the
 * parser keeps every key it is sent. So a known period with something after it
 * keeps the period's wording and says what the rest is, and a key nobody
 * anticipated at all still loses its underscores.
 */
export function windowSaid(scope: string): string {
  const known = WINDOWS[scope];
  if (known) return known;
  for (const [prefix, label] of Object.entries(WINDOWS)) {
    if (scope.startsWith(`${prefix}_`)) {
      return `${label}, ${scope.slice(prefix.length + 1).replace(/_/g, " ")}`;
    }
  }
  return scope.replace(/_/g, " ");
}

/**
 * How long until something, in the units a person would use.
 *
 * A monthly quota is a fortnight away and was being shown as `364 h 15 m`,
 * which nobody reads as two weeks. Hours stop being a unit somebody can hold
 * in their head at about two days. Zero parts are left out rather than
 * printed: `15d 4h` and not `15d 4h 0m`.
 *
 * Here rather than in `filing.ts`: this is the only thing on the desk that
 * counts down to anything, and `web/src/filing.ts` — where its twin lives —
 * goes away with the rest of `web/`.
 */
export function untilText(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "under a minute";
  const parts: string[] = [];
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const rest = mins % 60;
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (rest) parts.push(`${rest}m`);
  return parts.join(" ");
}

/** "resets in 1h 12m", from the unix second an agent reported. */
export function resets(at: number | null | undefined, now: number): string | null {
  if (!at) return null;
  const left = at * 1000 - now;
  if (left <= 0) return "due to reset";
  return `resets in ${untilText(left)}`;
}

/**
 * What a window says beside its name: when it turns over, or why it cannot.
 *
 * A provider that reports no percentage at all is a different answer from one
 * that reported a percentage and no reset time, and the line says which.
 */
export function whenSaid(l: Limit, now: number): string {
  if (l.usedPercent == null && l.status === "allowed") return "this agent reports no percentage";
  return resets(l.resetsAt, now) ?? "no reset time reported";
}

/** The figure at the right of a window's line, or the word where there is none. */
export function usedSaid(l: Limit): string {
  if (l.usedPercent != null) return `${percent(l.usedPercent)} used`;
  return l.status.charAt(0).toUpperCase() + l.status.slice(1);
}

/**
 * Where a subscription is filed, which is its path without its own name on the
 * end — `u/admin/perso_01m4anp7` is kept in `u/admin`.
 *
 * Not `filing.where`, which answers a different question. That one names the
 * root and says "yours" for your own, which is right on a page about your own
 * things. This page is a fleet seen from above, where "yours" beside four
 * other people's subscriptions says less than `u/admin` does.
 */
export const folder = (path: string) => path.split("/").slice(0, -1).join("/");
