/**
 * The Usage pane's rules, asserted where they live.
 *
 * Everything in `usage-rules.ts` is a function of its arguments, so none of
 * this needs a DOM — and the things worth protecting are the ones a reader of
 * the screen would otherwise have to take on trust: that a part which exists
 * never rounds to nothing, that a window nobody has seen before still reads as
 * English, that a quota is coloured by its number rather than by the word
 * beside it, and that the series hues are declared to live in exactly three
 * places.
 *
 * The rendered half — *are they actually only in those three places* — is in
 * `usage.test.tsx`, because that one can only be answered off markup.
 */
import { describe, expect, it } from "vitest";
import type { Directory, Group, Limit, Totals } from "~/api/generated/model";
import {
  BREADTH,
  GROUPS,
  METER_FILL,
  RANGES,
  SEARCHABLE,
  SERIES_FRAMES,
  SORTS,
  ceiling,
  columnFull,
  consumptionAsk,
  columnLabel,
  detail,
  folder,
  fuller,
  fullness,
  liveModels,
  meterWidth,
  modelsByWeight,
  peak,
  perConversation,
  percent,
  periodOf,
  plural,
  resets,
  rowKey,
  scopeIsFixed,
  scopeMatches,
  scopeName,
  seriesIn,
  share,
  sortSay,
  splitSort,
  tokensText,
  tone,
  unnamed,
  untilText,
  usedSaid,
  whenSaid,
  windowSaid,
  type SortKey,
} from "./usage-rules";

/* ── the containment rule, as it is declared ────────────────────────── */

describe("where a series hue may appear", () => {
  /**
   * **The list is the decision, so it is written down twice on purpose.**
   *
   * `usage.test.tsx` reads the rendered pane and asserts every
   * `--color-series-` sits inside one of these. That check is only as strong
   * as this list: adding `usage-row-meter` here would make a drifted screen
   * pass. So the list itself is pinned, and widening it fails here first —
   * which is the point at which somebody has to say out loud that they are
   * changing what `STYLE.md` promises.
   */
  it("is exactly the chart, the key and the layer that reads either", () => {
    expect([...SERIES_FRAMES]).toEqual(["usage-chart", "usage-key", "usage-tip"]);
  });

  /** A hue cannot be had without naming the frame it is painted in. */
  it("hands back the frame's id with the hue", () => {
    const chart = seriesIn("usage-chart", ["a", "b"]);
    expect(chart.testId).toBe("usage-chart");
    expect(chart.hue("a")).toBe("var(--color-series-1)");
    expect(chart.hue("b")).toBe("var(--color-series-2)");
  });

  /**
   * Past four the tail folds into the ground ramp rather than taking a fifth
   * hue, because a fold is a shape decision and a fifth hue would be a new
   * hue — one that would have to clear the same gate the four did.
   */
  it("folds past the fourth model rather than inventing a fifth hue", () => {
    const key = seriesIn("usage-key", ["a", "b", "c", "d", "e", "f"]);
    expect(key.hue("d")).toBe("var(--color-series-4)");
    expect(key.hue("e")).toBe("var(--color-mute)");
    expect(key.hue("f")).toBe("var(--color-mute)");
    expect(key.hue("nothing-on-this-page")).toBe("var(--color-mute)");
  });

  /** And a ledger row's meter is not a hue at all. */
  it("fills the ledger meter with the ground ramp", () => {
    expect(METER_FILL).toBe("var(--color-dim)");
    expect(METER_FILL).not.toContain("series");
  });
});

/* ── numbers people read ────────────────────────────────────────────── */

describe("the figures", () => {
  it("abbreviates a token count the way the headline reads it", () => {
    expect(tokensText(0)).toBe("0");
    expect(tokensText(999)).toBe("999");
    expect(tokensText(112_000)).toBe("112K");
    expect(tokensText(215_500)).toBe("215.5K");
    expect(tokensText(3_300_000)).toBe("3.3M");
    expect(tokensText(2_000_000_000)).toBe("2B");
  });

  /**
   * **Rounding is kept away from both ends.** A part that is there at all
   * must not read as nothing, and one that is short of everything must not
   * read as all of it — either would deny what the breakdown is for.
   */
  it("never rounds a part to none or to all of it", () => {
    expect(share(1, 1000)).toBe("<1%");
    expect(share(999, 1000)).toBe(">99%");
    expect(share(1000, 1000)).toBe("100%");
    expect(share(0, 1000)).toBe("");
    expect(share(5, 0)).toBe("");
    expect(share(440, 1000)).toBe("44%");
  });

  /** A decimal that is always zero is a decimal nobody reads. */
  it("gives a quota a tenth only where there is one", () => {
    expect(percent(68)).toBe("68%");
    expect(percent(77.5)).toBe("77.5%");
    expect(percent(91.04)).toBe("91%");
  });

  it("counts things in words, singular where it should be", () => {
    expect(plural(1, "turn")).toBe("1 turn");
    expect(plural(1284, "turn")).toBe("1,284 turns");
    expect(plural(1, "person", "people")).toBe("1 person");
    expect(plural(9, "person", "people")).toBe("9 people");
  });

  /**
   * 1.4 and 2.3 are different kinds of session, and "2 each" would be the
   * same sentence for both.
   */
  it("says how many turns a conversation took, to a tenth below ten", () => {
    const t = (turns: number, conversations: number) => ({ turns, conversations }) as Totals;
    expect(perConversation(t(1284, 173))).toBe("1,284 turns, about 7.4 each.");
    expect(perConversation(t(400, 20))).toBe("400 turns, about 20 each.");
    expect(perConversation(t(5, 0))).toBe("5 turns.");
    expect(perConversation(t(1, 1))).toBe("1 turn, about 1 each.");
  });

  /** A nice round ceiling that halves cleanly, so the two gridlines read. */
  it("picks a ceiling a gridline can halve", () => {
    expect(ceiling(0)).toBe(1);
    expect(ceiling(214_000)).toBe(240_000);
    expect(ceiling(1)).toBe(1);
    expect(ceiling(9_500)).toBe(10_000);
  });
});

describe("a column of the chart", () => {
  const nov18 = "2026-11-18T00:00:00.000Z";

  it("says what the axis has room for", () => {
    expect(columnLabel(nov18, "day")).toMatch(/^Nov \d\d$/);
    expect(columnLabel(nov18, "month")).toBe("Nov");
  });

  /** And the hover says what the axis could not: the year, and which week. */
  it("says what the axis could not", () => {
    expect(columnFull(nov18, "day")).toMatch(/^Nov \d\d$/);
    expect(columnFull(nov18, "week")).toMatch(/^Week of Nov \d\d$/);
    expect(columnFull(nov18, "month")).toBe("Nov 2026");
  });

  /**
   * Rounded to the day, so the query key is stable across renders —
   * otherwise every tick of the clock is a new request for the same answer.
   */
  it("asks for whole days, so the same answer is asked for once", () => {
    const morning = periodOf("d14", new Date(2026, 10, 26, 9, 14, 3));
    const evening = periodOf("d14", new Date(2026, 10, 26, 21, 55, 41));
    expect(morning).toEqual(evening);
    expect(new Date(morning.from).getDate()).toBe(13);
  });

  it("covers the period the segment names", () => {
    const { from, to } = periodOf("m12", new Date(2026, 10, 26, 12));
    const days = (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(RANGES.m12.days);
  });
});

/* ── the ledger ─────────────────────────────────────────────────────── */

const row = (g: Partial<Group>): Group =>
  ({
    conversations: 0,
    models: [],
    people: 0,
    pricedRows: 0,
    rows: 0,
    tasks: 0,
    tokens: 0,
    turns: 0,
    workspaces: 0,
    ...g,
  }) as Group;

describe("a ledger row", () => {
  /**
   * A task with a key and no name is one whose title did not come back; a
   * task with neither is work that was not filed against one. Two different
   * facts, and the row says which.
   */
  it("says why it has no name, rather than saying nothing", () => {
    expect(unnamed(row({ key: "FIRE-377" }), "task")).toBe("Title unavailable");
    expect(unnamed(row({}), "task")).toBe("No task assigned");
    expect(unnamed(row({}), "subscription")).toBe("No subscription");
    expect(unnamed(row({}), "model")).toBe("Unknown");
    expect(unnamed(row({ key: "gpt-5.1-codex" }), "model")).toBe("gpt-5.1-codex");
  });

  /** A row filed against nothing is a real row and is named `none`. */
  it("is named by its own key, or by `none`", () => {
    expect(rowKey(row({ key: "FIRE-412" }))).toBe("FIRE-412");
    expect(rowKey(row({}))).toBe("none");
    expect(rowKey(row({ key: null }))).toBe("none");
  });

  it("describes itself in the terms its dimension is about", () => {
    expect(detail(row({ workspaces: 9, conversations: 31 }), "task")).toBe(
      "9 workspaces, 31 conversations",
    );
    expect(detail(row({ tasks: 4, conversations: 12 }), "person")).toBe("4 tasks, 12 conversations");
    expect(detail(row({ people: 1, turns: 7 }), "model")).toBe("1 person, 7 turns");
    expect(detail(row({ turns: 2 }), "workspace")).toBe("2 turns");
    expect(detail(row({ tasks: 3, people: 2 }), "repository")).toBe("3 tasks, 2 people");
  });

  /**
   * **A child never reaches its parent's length**, or it reads as equal to
   * it; and nothing is shorter than 4%, or a row that did something reads as
   * a row that did nothing.
   */
  it("is as long as its share, with both ends held off", () => {
    expect(meterWidth(100, 100, false)).toBe(100);
    expect(meterWidth(50, 100, false)).toBe(50);
    expect(meterWidth(1, 100_000, false)).toBe(4);
    expect(meterWidth(100, 100, true)).toBe(68);
    expect(meterWidth(0, 100, true)).toBe(4);
  });
});

describe("the models on a page", () => {
  const series = [
    { models: [{ model: "a", tokens: 10 }, { model: "b", tokens: 40 }] },
    { models: [{ model: "a", tokens: 10 }, { model: "c", tokens: 5 }] },
  ];

  /**
   * One order for the whole page. The server orders each bucket by what it
   * did *in that bucket*, which is right for a list and wrong for a stack —
   * the segments would reshuffle column to column and the chart would read as
   * noise.
   */
  it("ranks by the whole period, not by one bucket", () => {
    expect(modelsByWeight(series)).toEqual(["b", "a", "c"]);
  });

  it("drops the zeroes and keeps the page's order", () => {
    const order = modelsByWeight(series);
    expect(
      liveModels(
        [
          { model: "c", tokens: 5 },
          { model: "a", tokens: 0 },
          { model: "b", tokens: 1 },
        ],
        order,
      ).map((m) => m.model),
    ).toEqual(["b", "c"]);
  });
});

/* ── the controls ───────────────────────────────────────────────────── */

describe("the sort, as one sentence", () => {
  /** Eight sentences, and no ALL-CAPS anywhere in any of them. */
  it("offers eight, and none of them shouts", () => {
    expect(SORTS).toHaveLength(8);
    for (const s of SORTS) {
      const said = sortSay(s.key, "task");
      expect(said).not.toMatch(/\b[A-Z]{2,}\b/);
      expect(said).not.toContain("__");
    }
  });

  /**
   * The breadth pair is the one that changes with the grouping: a task
   * sprawling across worktrees and a model reaching people are both breadth,
   * and neither is the other's column.
   */
  it("names what breadth counts, per grouping", () => {
    expect(sortSay("breadth:desc", "task")).toBe("most workspaces first");
    expect(sortSay("breadth:asc", "person")).toBe("fewest tasks first");
    expect(sortSay("breadth:desc", "model")).toBe("most people first");
    expect(sortSay("tokens:desc", "task")).toBe("most tokens first");
    expect(sortSay("name:asc", "task")).toBe("A to Z");
  });

  /** Every grouping has a word for it, or the sentence comes out broken. */
  it("has a breadth noun for every way of grouping", () => {
    for (const k of Object.keys(GROUPS)) expect(BREADTH[k as keyof typeof BREADTH]).toBeTruthy();
  });

  it("is two query parameters wearing one label", () => {
    expect(splitSort("tokens:desc")).toEqual({ sort: "tokens", direction: "desc" });
    expect(splitSort("name:asc")).toEqual({ sort: "name", direction: "asc" });
  });

  /** Every sentence the menu offers is one the query can be asked. */
  it("only offers sorts the wire knows", () => {
    for (const s of SORTS) {
      const { sort, direction } = splitSort(s.key as SortKey);
      expect(["tokens", "recent", "breadth", "name"]).toContain(sort);
      expect(["asc", "desc"]).toContain(direction);
    }
  });
});

describe("the scope", () => {
  const dir = (level?: string | null): Directory =>
    ({ id: "d_1", name: "Shared", slug: "shared", level }) as Directory;

  it("says what it is showing, and does not promise more", () => {
    expect(scopeName({ kind: "all" })).toBe("Everyone I can see");
    expect(scopeName({ kind: "me" })).toBe("Just me");
    expect(scopeName({ kind: "team", id: "t_1", name: "Platform" })).toBe("Platform");
  });

  /**
   * **Fixed is about reach, not about role.**
   *
   * Every read under this pane is narrowed to the paths somebody can see —
   * their own root plus any directory they hold a grant in — and there is no
   * administrator bypass in that predicate. So somebody holding no grant can
   * only ever see their own work, and every row of the scope menu would name
   * the same set.
   */
  it("is fixed for somebody holding no directory grant", () => {
    expect(scopeIsFixed([])).toBe(true);
    expect(scopeIsFixed([dir(null), dir(undefined)])).toBe(true);
  });

  /** An administrator is listed into directories they hold nothing in, with
   *  `level` absent — which is the case this reads rather than counting rows. */
  it("is not fixed for somebody holding one", () => {
    expect(scopeIsFixed([dir(null), dir("viewer")])).toBe(false);
    expect(scopeIsFixed([dir("writer")])).toBe(false);
  });

  const teams = [
    { id: "t_1", name: "Platform" },
    { id: "t_2", name: "Interface" },
  ];
  const people = [
    { id: "u_1", username: "kevin" },
    { id: "u_2", username: "dana" },
  ];

  it("offers everyone and just me before anybody's name", () => {
    const all = scopeMatches("", teams, people);
    expect(all.wide.map((w) => w.id)).toEqual(["all", "me"]);
    expect(all.teams).toHaveLength(2);
    expect(all.people).toHaveLength(2);
  });

  it("narrows to what was typed, across all three groups", () => {
    expect(scopeMatches("plat", teams, people).teams.map((t) => t.name)).toEqual(["Platform"]);
    expect(scopeMatches("dan", teams, people).people.map((p) => p.username)).toEqual(["dana"]);
    expect(scopeMatches("just", teams, people).wide.map((w) => w.id)).toEqual(["me"]);
  });

  it("has nothing at all to offer for a string nobody matches", () => {
    const none = scopeMatches("zzz", teams, people);
    expect(none.wide).toHaveLength(0);
    expect(none.teams).toHaveLength(0);
    expect(none.people).toHaveLength(0);
  });

  /** Finding beats ranking on the two lists long enough to need it. */
  it("offers a search on task and workspace only", () => {
    expect(SEARCHABLE).toEqual(["task", "workspace"]);
  });
});

/* ── the request the controls add up to ─────────────────────────────── */

describe("what the controls ask the server for", () => {
  const now = new Date(2026, 10, 26, 12);
  const base = {
    range: "d14" as const,
    group: "task" as const,
    then: "" as const,
    scope: { kind: "all" } as const,
    sort: "tokens:desc" as SortKey,
    find: "",
    limit: 25,
    now,
  };

  /**
   * **The query key is the request.** A control that is drawn and not folded
   * in here narrows nothing, and the pane would still look like it was
   * working — which is why the whole ask is one function the pane calls
   * rather than seven spreads at the call site.
   */
  it("is the period, the bucket, the grouping, the sort and the page", () => {
    expect(consumptionAsk(base)).toEqual({
      ...periodOf("d14", now),
      bucket: "day",
      group: "task",
      sort: "tokens",
      direction: "desc",
      limit: 25,
    });
  });

  it("buckets to match the period the segment names", () => {
    expect(consumptionAsk({ ...base, range: "d90" }).bucket).toBe("week");
    expect(consumptionAsk({ ...base, range: "m12" }).bucket).toBe("month");
  });

  /**
   * **`me` rather than the signed-in id**, which is the server's own
   * spelling: a link somebody shares must not quietly show them whoever sent
   * it.
   */
  it("narrows to a person, a team, or to whoever is asking", () => {
    expect(consumptionAsk({ ...base, scope: { kind: "me" } }).person).toBe("me");
    expect(consumptionAsk({ ...base, scope: { kind: "person", id: "u_2", name: "dana" } }).person).toBe("u_2");
    expect(consumptionAsk({ ...base, scope: { kind: "team", id: "t_1", name: "Platform" } }).team).toBe("t_1");
  });

  /** Everyone is the absence of a narrowing, not a narrowing to everyone. */
  it("asks for no scope at all when the scope is everyone", () => {
    const ask = consumptionAsk(base);
    expect(ask).not.toHaveProperty("person");
    expect(ask).not.toHaveProperty("team");
  });

  /** `find=""` on the wire is a different request from no `find` at all. */
  it("sends a search only when there is one, trimmed", () => {
    expect(consumptionAsk(base)).not.toHaveProperty("find");
    expect(consumptionAsk({ ...base, find: "   " })).not.toHaveProperty("find");
    expect(consumptionAsk({ ...base, find: "  renderer " }).find).toBe("renderer");
  });

  /** A second level equal to the first cuts nothing, so it is not sent. */
  it("sends a second level only where it is a different one", () => {
    expect(consumptionAsk({ ...base, then: "model" }).then).toBe("model");
    expect(consumptionAsk({ ...base, then: "task" })).not.toHaveProperty("then");
    expect(consumptionAsk(base)).not.toHaveProperty("then");
  });

  it("carries the sort as the two parameters the wire takes", () => {
    expect(consumptionAsk({ ...base, sort: "name:asc" })).toMatchObject({ sort: "name", direction: "asc" });
    expect(consumptionAsk({ ...base, sort: "breadth:desc" })).toMatchObject({ sort: "breadth", direction: "desc" });
  });

  /** Asking twice in the same day asks for the same answer, so it is asked
   *  for once. */
  it("is the same request twice in one day", () => {
    const morning = consumptionAsk({ ...base, now: new Date(2026, 10, 26, 7, 1) });
    const evening = consumptionAsk({ ...base, now: new Date(2026, 10, 26, 23, 1) });
    expect(morning).toEqual(evening);
  });

  it("pages by asking for more rather than by cutting what it has", () => {
    expect(consumptionAsk({ ...base, limit: 50 }).limit).toBe(50);
  });
});

/* ── limits ─────────────────────────────────────────────────────────── */

const limit = (l: Partial<Limit>): Limit =>
  ({ observedAt: "2026-11-26T00:00:00Z", scope: "month", status: "allowed", ...l }) as Limit;

describe("a quota window", () => {
  /**
   * **The number decides, not the word.** A provider says `allowed` right up
   * until it says `blocked`, so colouring by status drew a bar at 94% in
   * green and one at 79% in red. The word only gets a say when it is the
   * only thing we were told.
   */
  it("is coloured by its percentage wherever there is one", () => {
    expect(tone(limit({ usedPercent: 68 }))).toBe("sage");
    expect(tone(limit({ usedPercent: 74.9 }))).toBe("sage");
    expect(tone(limit({ usedPercent: 75 }))).toBe("amber");
    expect(tone(limit({ usedPercent: 89 }))).toBe("amber");
    expect(tone(limit({ usedPercent: 90 }))).toBe("brick");
    expect(tone(limit({ usedPercent: 94, status: "allowed" }))).toBe("brick");
  });

  it("falls back to the word only where there is no number", () => {
    expect(tone(limit({ status: "allowed" }))).toBe("sage");
    expect(tone(limit({ status: "blocked" }))).toBe("brick");
    expect(tone(limit({ status: "rejected" }))).toBe("brick");
    expect(tone(limit({ status: "reached" }))).toBe("amber");
  });

  /** **Never ember.** Urgency has one carrier and this screen may not use it. */
  it("is never ember, however full it is", () => {
    for (const pct of [0, 50, 75, 90, 99, 100]) expect(tone(limit({ usedPercent: pct }))).not.toBe("ember");
    expect(tone(limit({ status: "blocked" }))).not.toBe("ember");
  });

  /** A blocked window with no percentage is full, because it is. */
  it("counts a block as full and an unreported one as unknown", () => {
    expect(fullness(limit({ usedPercent: 41 }))).toBe(41);
    expect(fullness(limit({ status: "blocked" }))).toBe(100);
    expect(fullness(limit({ status: "allowed" }))).toBeNull();
  });

  /** An account is ranked by its fullest window: the one nearest running out
   *  is the reason to look at it, whatever the others say. */
  it("ranks an account by its fullest window", () => {
    expect(peak([limit({ usedPercent: 41 }), limit({ usedPercent: 68 })])).toBe(68);
    expect(peak([limit({ status: "allowed" })])).toBeNull();
  });

  /** "We do not know" must not sort to the top of "least used". */
  it("sorts a window with no number last, either way round", () => {
    const known = limit({ usedPercent: 10 });
    const unknown = limit({ status: "allowed" });
    expect(fuller(unknown, known, "desc")).toBeGreaterThan(0);
    expect(fuller(unknown, known, "asc")).toBeGreaterThan(0);
    expect(fuller(known, unknown, "asc")).toBeLessThan(0);
  });

  /** `five_hour` is how an agent spells it; nobody says that out loud. */
  it("says a window in words, however the provider spelt it", () => {
    expect(windowSaid("five_hour")).toBe("5-hour window");
    expect(windowSaid("5_hour")).toBe("5-hour window");
    expect(windowSaid("seven_day")).toBe("7-day window");
    expect(windowSaid("month")).toBe("this month");
    expect(windowSaid("month_code")).toBe("this month, coding");
    expect(windowSaid("account")).toBe("this account");
  });

  /**
   * A key nobody has seen is still read as English. Claude Code's own binary
   * knows `seven_day_opus`, none has reached the wire here, and the parser
   * keeps every key it is sent — so one will arrive without anybody changing
   * anything, and it must not read as "seven day opus".
   */
  it("reads a window nobody has seen yet", () => {
    expect(windowSaid("seven_day_opus")).toBe("7-day window, opus");
    expect(windowSaid("five_hour_sonnet")).toBe("5-hour window, sonnet");
    expect(windowSaid("rolling_fortnight")).toBe("rolling fortnight");
  });

  /** A fortnight shown as `364 h 15 m` is a number nobody reads as two weeks. */
  it("counts down in units somebody can hold in their head", () => {
    expect(untilText(72 * 60_000)).toBe("1h 12m");
    expect(untilText(15 * 1440 * 60_000 + 4 * 60 * 60_000)).toBe("15d 4h");
    expect(untilText(2 * 1440 * 60_000 + 5 * 60_000)).toBe("2d 5m");
    expect(untilText(20_000)).toBe("under a minute");
  });

  const now = Date.UTC(2026, 10, 26, 12, 0, 0);

  it("says when it turns over, or that it already has", () => {
    expect(resets(now / 1000 + 4320, now)).toBe("resets in 1h 12m");
    expect(resets(now / 1000 - 10, now)).toBe("due to reset");
    expect(resets(null, now)).toBeNull();
  });

  /**
   * **Three different silences, said three different ways.** A provider that
   * reports no percentage at all is a different answer from one that reported
   * a percentage and no reset time, and both are different from a window that
   * has turned over.
   */
  it("tells the three silences apart", () => {
    expect(whenSaid(limit({ status: "allowed" }), now)).toBe("this agent reports no percentage");
    expect(whenSaid(limit({ usedPercent: 50 }), now)).toBe("no reset time reported");
    expect(whenSaid(limit({ usedPercent: 50, resetsAt: now / 1000 + 4320 }), now)).toBe(
      "resets in 1h 12m",
    );
    expect(whenSaid(limit({ status: "blocked" }), now)).toBe("no reset time reported");
  });

  it("says the figure, or the word where there is none", () => {
    expect(usedSaid(limit({ usedPercent: 68 }))).toBe("68% used");
    expect(usedSaid(limit({ usedPercent: 77.5 }))).toBe("77.5% used");
    expect(usedSaid(limit({ status: "blocked" }))).toBe("Blocked");
    expect(usedSaid(limit({ status: "allowed" }))).toBe("Allowed");
  });

  /**
   * A subscription's own name is on the end of its path, and the page wants
   * the folder it sits in — `u/admin`, not `yours`, because this page is a
   * fleet seen from above.
   */
  it("files a subscription by its folder rather than by itself", () => {
    expect(folder("u/admin/perso_01m4anp7")).toBe("u/admin");
    expect(folder("d/platform/acct_1")).toBe("d/platform");
    expect(folder("u/kevin")).toBe("u");
  });
});
