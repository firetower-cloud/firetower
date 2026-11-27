/**
 * The Usage pane, drawn — and the one check the whole screen was blocked on.
 *
 * `renderToStaticMarkup` with a seeded cache: no jsdom, no network, no
 * testing-library. Every read the pane makes is seeded, so what is asserted
 * here is the markup a browser would be handed.
 *
 * ## The assertion that belongs to no single id
 *
 * > `--color-series-` appears in the rendered pane **only** inside
 * > `usage-chart`, `usage-key` and `usage-tip`.
 *
 * That is the containment rule from `STYLE.md` made testable, and it is the
 * one that fails first if the screen drifts back to the one the web ships —
 * where the same four hues are also on the stacked meter of every one of
 * twenty-five ledger rows, and in a key floating above them.
 *
 * It needs a checker that can tell *inside* from *anywhere*, so the checker
 * is written here and **proved against markup that should fail it** before it
 * is pointed at the pane. A guard that cannot fail is not a guard.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getConsumptionQueryKey } from "~/api/generated/consumption/consumption";
import { getListAccountsQueryKey } from "~/api/generated/accounts/accounts";
import {
  getListColleaguesQueryKey,
  getListDirectoriesQueryKey,
  getListTeamsQueryKey,
} from "~/api/generated/access/access";
import type { Account, ByModel, Consumption, Group, Totals } from "~/api/generated/model";
import { Ledger, Usage, Tip } from "./Usage";
import { SERIES_FRAMES, periodOf, readState } from "./usage-rules";

/* ══ the containment checker ═══════════════════════════════════════════
   A tag-stack walk rather than a regex, because the question is *which
   element is this string inside of* and a regex cannot answer that. React's
   server renderer escapes `<` and `>` inside attribute values, so a tag can
   be matched without worrying about a stray angle bracket. */

/** HTML's void elements, which close themselves without saying so. */
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr",
]);

const TAG = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/g;

/**
 * Every place a string appears, each reported as the `data-testid`s it is
 * inside — outermost first, and the element's own id last where the string is
 * in that element's own attributes.
 *
 * An element with no `data-testid` contributes nothing, which is what makes
 * the answer "is it inside a named frame" rather than "how deep is it".
 */
export function sitesOf(html: string, needle: string): string[][] {
  const out: string[][] = [];
  const stack: (string | undefined)[] = [];
  const ids = (s: (string | undefined)[]) => s.filter((x): x is string => !!x);
  let last = 0;

  for (const m of html.matchAll(TAG)) {
    const at = m.index ?? 0;
    if (html.slice(last, at).includes(needle)) out.push(ids(stack));
    last = at + m[0].length;

    const [, closing, tag, attrs, slash] = m;
    if (closing) {
      stack.pop();
      continue;
    }
    const own = /\sdata-testid="([^"]*)"/.exec(attrs)?.[1];
    if (attrs.includes(needle)) out.push(ids([...stack, own]));
    if (!slash && !VOID.has(tag.toLowerCase())) stack.push(own);
  }
  if (html.slice(last).includes(needle)) out.push(ids(stack));
  return out;
}

/** The sites that are not inside any of the three frames that may carry one. */
const escaped = (html: string) =>
  sitesOf(html, "--color-series-").filter(
    (path) => !path.some((id) => (SERIES_FRAMES as readonly string[]).includes(id)),
  );

describe("the containment checker, before it is trusted with the pane", () => {
  it("finds a hue painted inside the chart, and calls it contained", () => {
    const html = `<div data-testid="usage-pane"><svg data-testid="usage-chart"><rect fill="var(--color-series-1)"></rect></svg></div>`;
    expect(sitesOf(html, "--color-series-")).toEqual([["usage-pane", "usage-chart"]]);
    expect(escaped(html)).toEqual([]);
  });

  /** **The mutation this exists for**: the web's stacked ledger meter. */
  it("catches a hue on a ledger row's meter", () => {
    const html = `<div data-testid="usage-pane"><span data-testid="usage-row-meter-FIRE-412"><i style="background:var(--color-series-2)"></i></span></div>`;
    expect(escaped(html)).toEqual([["usage-pane", "usage-row-meter-FIRE-412"]]);
  });

  it("catches one on an element with no id at all", () => {
    expect(escaped(`<div><i style="background:var(--color-series-3)"></i></div>`)).toEqual([[]]);
  });

  /** A self-closing tag must not leave the stack open, or everything after it
   *  reads as being inside it — which would make the check pass by accident. */
  it("does not let a self-closed or void tag swallow what follows it", () => {
    const html = `<div data-testid="usage-chart"><br/><input value=""/></div><i style="background:var(--color-series-4)"></i>`;
    expect(escaped(html)).toEqual([[]]);
  });

  it("catches one in text rather than in an attribute", () => {
    expect(escaped(`<div data-testid="x">var(--color-series-1)</div>`)).toEqual([["x"]]);
  });

  /** Nested inside a frame that is itself nested still counts as contained. */
  it("looks at the whole ancestry, not just the parent", () => {
    const html = `<div data-testid="usage-key"><span class="it"><i style="background:var(--color-series-1)"></i></span></div>`;
    expect(escaped(html)).toEqual([]);
  });

  it("finds nothing in markup that has none", () => {
    expect(sitesOf(`<div data-testid="usage-pane"><i style="background:var(--color-dim)"></i></div>`, "--color-series-")).toEqual([]);
  });
});

/* ══ the fleet, invented ═══════════════════════════════════════════════ */

const MODELS = ["claude-sonnet-4-5", "gpt-5.1-codex", "claude-opus-4-1", "kimi-k2-0905", "glm-4-6"];
const WEIGHTS = [0.44, 0.24, 0.18, 0.11, 0.03];

const by = (tokens: number): ByModel[] =>
  MODELS.map((model, i) => ({ model, tokens: Math.round(tokens * WEIGHTS[i]) }));

const group = (g: Partial<Group>): Group =>
  ({
    conversations: 3,
    models: by(g.tokens ?? 1000),
    people: 2,
    pricedRows: 0,
    rows: 4,
    tasks: 1,
    tokens: 1000,
    turns: 9,
    workspaces: 2,
    ...g,
  }) as Group;

const TOTALS: Totals = {
  cacheReadTokens: 2_318_470,
  cacheWrite1hTokens: 118_402,
  cacheWrite5mTokens: 55_624,
  cacheWriteTokens: 174_026,
  conversations: 173,
  inputTokens: 412_884,
  outputTokens: 96_210,
  people: 9,
  pricedRows: 300,
  rows: 420,
  tasks: 41,
  tokens: 3_001_590,
  turns: 1_284,
  unreportedTurns: 38,
  workspaces: 96,
};

const COLUMNS = Array.from({ length: 14 }, (_, i) => ({
  start: new Date(Date.UTC(2026, 10, 13 + i)).toISOString(),
  models: by(180_000 + i * 9_000),
}));

const ROWS: Group[] = [
  group({ key: "FIRE-412", name: "Bring the administration screens into the renderer", tokens: 214_000, workspaces: 9, conversations: 31 }),
  group({ key: "FIRE-418", name: "Serve the renderer from the control plane’s root", tokens: 183_000 }),
  // A task whose title did not come back, and work filed against no task.
  group({ key: "FIRE-377", name: null, tokens: 94_000 }),
  group({ key: null, name: null, tokens: 61_000 }),
];

const FULL: Consumption = { totals: TOTALS, series: COLUMNS, groups: ROWS, groupCount: ROWS.length };

const ACCOUNTS: Account[] = [
  {
    credentialSet: true,
    enabled: true,
    id: "acc_kevin",
    isDefault: true,
    kind: "claude",
    mode: "Subscription",
    name: "Anthropic — kevin",
    path: "u/kevin/perso_01m4anp7",
    revision: 1,
    state: "ready",
    limits: [
      { observedAt: "2026-11-26T09:00:00Z", scope: "five_hour", status: "allowed", usedPercent: 68, resetsAt: 1795000000 },
      { observedAt: "2026-11-26T09:00:00Z", scope: "seven_day", status: "allowed", usedPercent: 41 },
    ],
  },
  {
    credentialSet: true,
    enabled: true,
    id: "acc_ops",
    isDefault: false,
    kind: "claude",
    mode: "Subscription",
    name: "Anthropic — ops",
    path: "d/ops/acct_2",
    revision: 1,
    state: "ready",
    // Reports no percentage at all, so it gets no meter. The empty space is
    // the finding, not a gap to fill.
    limits: [{ observedAt: "2026-11-26T09:00:00Z", scope: "account", status: "allowed" }],
  },
];

const DIRECTORIES = [
  { id: "d_1", name: "Shared", slug: "shared", level: "writer", workspaces: 0, hosts: 0, agentAccounts: 0, secrets: 0, skills: 0 },
];
const TEAMS = [{ id: "t_1", name: "Platform", everyone: false, members: 4 }];
const COLLEAGUES = [{ id: "u_1", username: "kevin" }, { id: "u_2", username: "dana" }];

/** The parameters the pane asks with, for the opening state of its controls. */
function asks(over: Partial<Record<string, unknown>> = {}) {
  const { from, to } = periodOf("d14", new Date());
  return { from, to, bucket: "day", group: "task", sort: "tokens", direction: "desc", limit: 25, ...over };
}

type Seed = {
  /** What `/consumption` answered, or nothing at all. */
  answer?: Consumption;
  /** The parameters that answer belongs to. */
  params?: Record<string, unknown>;
  /** A failure instead of an answer. `status` absent is a server gone dark. */
  failed?: { status?: number };
  /** A request still in flight over the answer above. */
  fetching?: boolean;
  accounts?: Account[];
  directories?: typeof DIRECTORIES;
};

function draw(seed: Seed = {}): string {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false, retryOnMount: false } },
  });
  cache.setQueryData(getListAccountsQueryKey(), seed.accounts ?? ACCOUNTS);
  cache.setQueryData(getListTeamsQueryKey(), TEAMS);
  cache.setQueryData(getListColleaguesQueryKey(), COLLEAGUES);
  cache.setQueryData(getListDirectoriesQueryKey(), seed.directories ?? DIRECTORIES);

  const key = getConsumptionQueryKey((seed.params ?? asks()) as never);
  if (seed.failed) {
    /* The cache will not report a seeded failure to a fresh observer unless
       it is told not to retry on mount — otherwise the observer starts a
       retry and reports *pending*, which is a different state entirely. */
    const entry = cache.getQueryCache().build(cache, { queryKey: key } as never);
    entry.setState({
      status: "error",
      error: seed.failed.status ? Object.assign(new Error("Something went wrong."), seed.failed) : new Error("Failed to fetch"),
      fetchStatus: "idle",
      errorUpdatedAt: Date.now(),
      errorUpdateCount: 1,
    } as never);
  } else if (seed.answer) {
    cache.setQueryData(key, seed.answer);
    if (seed.fetching) {
      cache.getQueryCache().find({ queryKey: key })?.setState({ fetchStatus: "fetching" } as never);
    }
  }

  return renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <Usage />
    </QueryClientProvider>,
  );
}

/**
 * The same render, with the parameters the pane actually asked the server
 * for.
 *
 * The query key *is* the request, so reading it back is how "the controls
 * govern the read" is asserted without a browser to press anything in: a
 * control that is drawn but not wired would still draw, and would ask with
 * the wrong parameters.
 */
function asked(seed: Seed = {}): Record<string, unknown> {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false, retryOnMount: false } },
  });
  cache.setQueryData(getListAccountsQueryKey(), seed.accounts ?? ACCOUNTS);
  cache.setQueryData(getListTeamsQueryKey(), TEAMS);
  cache.setQueryData(getListColleaguesQueryKey(), COLLEAGUES);
  cache.setQueryData(getListDirectoriesQueryKey(), seed.directories ?? DIRECTORIES);
  if (seed.answer) cache.setQueryData(getConsumptionQueryKey((seed.params ?? asks()) as never), seed.answer);
  renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <Usage />
    </QueryClientProvider>,
  );
  const found = cache
    .getQueryCache()
    .getAll()
    .filter((q) => q.queryKey[0] === "/api/v1/consumption")
    .map((q) => q.queryKey[1] as Record<string, unknown>);
  expect(found).toHaveLength(1);
  return found[0];
}

/** A rendered subtree, by the id on its outermost element. */
function subtree(html: string, testId: string): string {
  const open = html.indexOf(`data-testid="${testId}"`);
  if (open < 0) throw new Error(`no ${testId} in the rendered pane`);
  const from = html.lastIndexOf("<", open);
  const tag = /^<([a-zA-Z][\w:-]*)/.exec(html.slice(from))?.[1];
  if (!tag) throw new Error(`no tag for ${testId}`);
  if (VOID.has(tag.toLowerCase())) return html.slice(from, html.indexOf(">", open) + 1);
  let depth = 0;
  for (const m of html.slice(from).matchAll(TAG)) {
    const [whole, closing, name, , slash] = m;
    if (name.toLowerCase() !== tag.toLowerCase()) continue;
    if (closing) depth -= 1;
    else if (!slash && !VOID.has(name.toLowerCase())) depth += 1;
    if (depth === 0) return html.slice(from, from + (m.index ?? 0) + whole.length);
  }
  return html.slice(from);
}

/* The clock is pinned so the period the pane asks for is the period the seed
   was filed under. Without it the two disagree across a midnight. */
beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 26, 12, 0, 0));
});
afterAll(() => vi.useRealTimers());

/* ══ the rule the whole screen was blocked on ══════════════════════════ */

describe("the series hues are contained", () => {
  it("appear in the pane, so the check has something to find", () => {
    // Half of the pair: a containment check over markup with no hues in it
    // passes while asserting nothing at all.
    expect(sitesOf(draw({ answer: FULL }), "--color-series-").length).toBeGreaterThan(0);
  });

  /** **The assertion that fails first if the screen drifts back.** */
  it("appear only inside the chart and the key", () => {
    expect(escaped(draw({ answer: FULL }))).toEqual([]);
  });

  /** And the third frame, which is drawn on `body` rather than in the pane. */
  it("appear only inside the layer, on the layer", () => {
    const html = renderToStaticMarkup(
      <Tip
        tip={{ x: 300, y: 300, from: "row", head: "A task", models: by(100_000) }}
        models={MODELS}
      />,
    );
    expect(sitesOf(html, "--color-series-").length).toBeGreaterThan(0);
    expect(escaped(html)).toEqual([]);
  });

  /**
   * **One length, not a stack.** The change that makes the rule true rather
   * than aspirational: every ledger row's meter is a single child filled from
   * the ground ramp, with no hue anywhere under it.
   */
  it("are nowhere under a ledger row's meter, which is one neutral length", () => {
    const html = draw({ answer: FULL });
    for (const g of ROWS) {
      const meter = subtree(html, `usage-row-meter-${g.key ?? "none"}`);
      expect(meter).toContain("var(--color-dim)");
      expect(meter).not.toContain("--color-series-");
      // Exactly one child: the length. Not a stack of segments.
      expect(meter.match(/<span/g) ?? []).toHaveLength(2); // the meter, and its one child
      expect(meter.match(/<i/g) ?? []).toHaveLength(1);
    }
  });

  /** Nothing on this screen may use ember. Urgency has one carrier. */
  it("never reach for ember, and neither does anything else on the pane", () => {
    expect(draw({ answer: FULL })).not.toContain("ember");
  });
});

/* ══ the pane, its ids and its copy ════════════════════════════════════ */

describe("the pane", () => {
  const html = () => draw({ answer: FULL });

  it("is a page called Usage, and says what it is", () => {
    const h = html();
    expect(h).toContain('data-testid="usage-pane"');
    expect(subtree(h, "usage-title")).toContain("Usage");
    expect(subtree(h, "usage-sub")).toContain("What the agents spent, and on what.");
    // Not the web's eyebrow: the destination says Organisation.
    expect(h).not.toContain("Organization");
  });

  it("offers all three periods at once, with exactly one pressed", () => {
    const h = subtree(html(), "usage-period");
    for (const [id, says] of [["d14", "14 days"], ["d90", "90 days"], ["m12", "12 months"]]) {
      expect(h).toContain(`data-testid="usage-period-${id}"`);
      expect(h).toContain(says);
    }
    expect(h.match(/aria-pressed="true"/g) ?? []).toHaveLength(1);
  });

  it("opens on everyone it can see, as a menu rather than a sentence", () => {
    expect(subtree(html(), "usage-scope")).toContain("Everyone I can see");
  });

  it("draws the headline, abbreviated, over what it is made of", () => {
    const h = html();
    expect(subtree(h, "usage-total")).toContain("3M");
    expect(subtree(h, "usage-total-caption")).toContain("tokens processed");
  });

  it("names every column of the chart, and makes each one reachable", () => {
    const h = html();
    const chart = subtree(h, "usage-chart");
    expect(chart).toContain("Billed tokens per day, split by model.");
    for (const c of COLUMNS) {
      const id = `usage-chart-column-${c.start.slice(0, 10)}`;
      expect(chart).toContain(`data-testid="${id}"`);
    }
    expect((chart.match(/data-testid="usage-chart-column-/g) ?? []).length).toBe(COLUMNS.length);
    // Every hit target is in the tab order, or the keyboard is told less than
    // the mouse.
    expect((chart.match(/tabindex="0"/gi) ?? []).length).toBe(COLUMNS.length);
  });

  it("reads the key under the chart, with each model's share", () => {
    const key = subtree(html(), "usage-key");
    expect(key).toContain('data-testid="usage-key-claude-sonnet-4-5"');
    // The shares are of the chart's own sum, so they add up to the chart.
    expect(key).toContain("44%");
    // Four hued entries at most, then the tail folds.
    expect((key.match(/--color-series-/g) ?? []).length).toBe(4);
    expect(key).toContain('data-testid="usage-key-folded"');
    expect(key).toContain("1 more model");
  });

  it("draws nothing for a key under two models", () => {
    const one: Consumption = {
      ...FULL,
      series: [{ start: COLUMNS[0].start, models: [{ model: "claude-sonnet-4-5", tokens: 10 }] }],
    };
    expect(draw({ answer: one })).not.toContain('data-testid="usage-key"');
  });

  it("counts the four things the work was made of", () => {
    const h = html();
    for (const [id, label] of [
      ["workspaces", "Workspaces"],
      ["tasks", "Tasks"],
      ["conversations", "Conversations"],
      ["people", "People"],
    ]) {
      expect(subtree(h, `usage-figure-${id}`)).toContain(label);
    }
    expect(subtree(h, "usage-figure-conversations")).toContain("1,284 turns, about 7.4 each.");
    expect(subtree(h, "usage-figure-workspaces")).toContain("Holding 173 conversations.");
  });

  /** Said plainly, and **no agent is named** — which of them report is a
   *  moving fact and a sentence that names one goes stale facing the person
   *  it misleads. */
  it("says what it could not count, without blaming anybody by name", () => {
    const said = subtree(html(), "usage-unreported");
    expect(said).toContain("38 turns above have no tokens counted.");
    expect(said).toContain("Their agent reported none, so they are in the turn count and not in the totals.");
    for (const agent of ["Cursor", "Claude", "Codex", "Kimi"]) expect(said).not.toContain(agent);
  });

  it("leaves the sentence out when every turn was counted", () => {
    const all: Consumption = { ...FULL, totals: { ...TOTALS, unreportedTurns: 0 } };
    expect(draw({ answer: all })).not.toContain('data-testid="usage-unreported"');
  });
});

/* ══ the ledger ════════════════════════════════════════════════════════ */

describe("the ledger", () => {
  const html = () => draw({ answer: FULL });

  it("says how it is cut, and in what", () => {
    const h = html();
    expect(subtree(h, "usage-ledger-heading")).toContain("Where it went, by task");
    expect(subtree(h, "usage-ledger-note")).toContain("Billed tokens in this period.");
    // The web's three-column header strip is gone; the note replaces it.
    expect(h).not.toContain(">Tokens<");
  });

  it("draws a row for every group, named by its own key", () => {
    const h = html();
    for (const g of ROWS) {
      const id = g.key ?? "none";
      expect(h).toContain(`data-testid="usage-row-${id}"`);
      expect(h).toContain(`data-testid="usage-row-tokens-${id}"`);
      expect(h).toContain(`data-testid="usage-row-meter-${id}"`);
    }
    expect(subtree(h, "usage-row-tokens-FIRE-412")).toContain("214K");
  });

  /** A task with a key and no name is one whose title did not come back; a
   *  task with neither is work that was not filed against one. */
  it("says why a row has no name, in italic", () => {
    const h = html();
    const noTitle = subtree(h, "usage-row-name-FIRE-377");
    expect(noTitle).toContain("Title unavailable");
    expect(noTitle).toContain("unnamed");
    expect(subtree(h, "usage-row-name-none")).toContain("No task assigned");
  });

  /** A greyed control is how an interface says you are being withheld from,
   *  and nothing is: with no second level there is nothing to swap. */
  it("does not draw the swap until there are two levels to swap", () => {
    const h = html();
    expect(h).not.toContain('data-testid="usage-swap-levels"');
    expect(h).not.toContain("disabled");
  });

  it("offers eight sorts as sentences, and shouts in none of them", () => {
    const sort = subtree(html(), "usage-sort");
    expect(sort).toContain("most tokens first");
    expect(sort).not.toContain("DESC");
    expect(sort).not.toContain("ASC");
  });

  it("offers a find on task, and none on a grouping too short to need one", () => {
    expect(subtree(html(), "usage-find-input")).toContain("Find a task");
    const byModel = draw({
      answer: FULL,
      params: asks({ group: "model" }),
    });
    expect(byModel).not.toContain('data-testid="usage-find"');
  });

  it("says what is not on screen, without drawing it as a row", () => {
    const more: Consumption = {
      ...FULL,
      groupCount: 41,
      rest: group({ key: null, name: null, tokens: 930_000 }),
    };
    const h = draw({ answer: more });
    const rest = subtree(h, "usage-rest");
    expect(rest).toContain("37 more tasks");
    expect(rest).toContain("% of the period");
    // Not a row: no meter, no fill, nothing to set the scale by.
    expect(rest).not.toContain("data-testid=\"usage-row-meter");
    expect(rest).not.toContain("fill");
    expect(subtree(h, "usage-more")).toContain("Show 25 more");
  });

  it("stops offering more once the list is complete", () => {
    expect(draw({ answer: FULL })).not.toContain('data-testid="usage-more"');
  });
});

/* ══ the ledger's own controls, driven directly ════════════════════════
   A static render cannot press a button, and four of the states the contract
   names are reached by pressing one: a second level, a search that matched
   nothing, the swap that arrives with the second level, and the grouping the
   find follows. `Ledger` takes all four as props, so they are driven here
   rather than left undrawn — the alternative is a jsdom, which this suite
   does not have, or four states nobody ever renders. */

const ledger = (over: Partial<Parameters<typeof Ledger>[0]> = {}) =>
  renderToStaticMarkup(
    <Ledger
      settling={false}
      groups={ROWS}
      total={ROWS.length}
      periodTokens={TOTALS.tokens}
      by="task"
      then=""
      sort="tokens:desc"
      typed=""
      noMatch={false}
      searched=""
      open={null}
      limit={25}
      onTip={() => {}}
      onOpen={() => {}}
      onTyped={() => {}}
      onGroup={() => {}}
      onThen={() => {}}
      onSwap={() => {}}
      onSort={() => {}}
      onMore={() => {}}
      {...over}
    />,
  );

/**
 * **The ledger subtree is handed no model order at all**, which is what makes
 * the containment rule structural rather than remembered: there is no hue
 * function in scope under `Ledger`, so no row can paint one even by accident.
 * The property is the type's, and this is the assertion that it is live.
 */
describe("the ledger has nothing to paint a hue with", () => {
  it("draws no series anywhere, however it is cut or opened", () => {
    const kids = Array.from({ length: 3 }, (_, i) =>
      group({ key: `k${i}`, name: MODELS[i], tokens: 9_000 - i * 500 }),
    );
    for (const over of [
      {},
      { then: "model" as const, groups: [{ ...ROWS[0], children: kids }] },
      { then: "model" as const, groups: [{ ...ROWS[0], children: kids }], open: "FIRE-412" },
      { by: "model" as const },
      { rest: group({ key: null, tokens: 9_000 }), total: 41 },
    ]) {
      const h = ledger(over);
      expect(sitesOf(h, "--color-series-")).toEqual([]);
      expect(h).toContain("var(--color-dim)");
    }
  });
});

describe("the ledger under a second level", () => {
  const kids = Array.from({ length: 8 }, (_, i) =>
    group({ key: `${MODELS[i % MODELS.length]}-${i}`, name: MODELS[i % MODELS.length], tokens: 9_000 - i * 500 }),
  );
  const withKids = [{ ...ROWS[0], children: kids }, { ...ROWS[1], children: [] }, ...ROWS.slice(2)];

  it("says both levels in its own heading", () => {
    expect(subtree(ledger({ then: "model" }), "usage-ledger-heading")).toContain(
      "Where it went, by task and then by model",
    );
  });

  /** The chevron and the swap arrive together with the second level, and
   *  neither is drawn — let alone greyed — before there is one. */
  it("makes every row openable, and offers the swap", () => {
    const h = ledger({ then: "model", groups: withKids });
    expect(h).toContain('data-testid="usage-row-chevron-FIRE-412"');
    expect(h).toContain('data-testid="usage-swap-levels"');
    expect(h).toContain("Swap the two levels. The totals do not move.");
    expect(subtree(h, "usage-row-FIRE-412")).toContain('aria-expanded="false"');
    expect(subtree(h, "usage-row-FIRE-412")).toContain('role="button"');
  });

  /**
   * **The route the ledger's meter no longer draws.** Opening a row under
   * *then by model* is the first-class way to the split the web stacked on
   * every row — and the children are the models.
   */
  it("opens one row onto six children, and says what is left", () => {
    const h = ledger({ then: "model", groups: withKids, open: "FIRE-412" });
    const block = subtree(h, "usage-row-children-FIRE-412");
    const childRows = block.match(/data-testid="usage-row-(?!name|meter|tokens|chevron|children)/g);
    expect(childRows ?? []).toHaveLength(6);
    expect(subtree(h, "usage-row-children-more-FIRE-412")).toContain("2 more, not shown");
    expect(subtree(h, "usage-row-FIRE-412")).toContain('aria-expanded="true"');
    // And the children's own meters are still one neutral length each.
    expect(block).not.toContain("--color-series-");
    expect(block).toContain("var(--color-dim)");
  });

  it("says plainly when a row has nothing under it", () => {
    const h = ledger({ then: "model", groups: withKids, open: "FIRE-418" });
    expect(subtree(h, "usage-row-children-none-FIRE-418")).toContain("Nothing to break this down by.");
  });

  /** Directory is a place, not a thing that happens inside another row. */
  it("does not offer directory as a second level", () => {
    const h = ledger();
    const then = subtree(h, "usage-then-by");
    expect(then).toContain("then by nothing");
    expect(h).toContain("then by nothing");
  });
});

describe("the ledger when a search matched nothing", () => {
  /** A control the reader changed, so a note at the row's own left edge —
   *  not a blank down the middle of the pane. */
  it("quotes what was typed and offers one way back", () => {
    const h = ledger({ noMatch: true, searched: "fourteen", typed: "fourteen", groups: [] });
    const note = subtree(h, "usage-empty-find");
    expect(note).toContain("Nothing matches");
    expect(note).toContain("“fourteen”");
    expect(note).toContain("in this period.");
    expect(subtree(h, "usage-empty-find-clear")).toContain("Clear the search");
    // Never a primary: the only control it carries undoes what caused it.
    expect(subtree(h, "usage-empty-find-clear")).not.toContain("primary");
    // The ledger's heading and its controls stay — it is the list that is
    // empty, not the section.
    expect(h).toContain('data-testid="usage-ledger-heading"');
    expect(h).not.toContain('data-testid="usage-row-FIRE-412"');
  });
});

describe("the ledger's grouping", () => {
  it("names the grouping in the heading and in the control", () => {
    for (const [key, word] of [["person", "person"], ["model", "model"], ["repository", "repository"]]) {
      const h = ledger({ by: key as never });
      expect(subtree(h, "usage-ledger-heading")).toContain(`Where it went, by ${word}`);
      expect(subtree(h, "usage-group-by")).toContain(`by ${word}`);
    }
  });

  /** Finding beats ranking only where the list is long enough to need it. */
  it("offers a find on workspace and not on person", () => {
    expect(subtree(ledger({ by: "workspace" }), "usage-find-input")).toContain("Find a workspace");
    expect(ledger({ by: "person" })).not.toContain('data-testid="usage-find"');
  });

  /** The breadth pair takes the grouping's own noun. */
  it("renames the breadth sort per grouping", () => {
    expect(ledger({ by: "task", sort: "breadth:desc" })).toContain("most workspaces first");
    expect(ledger({ by: "person", sort: "breadth:desc" })).toContain("most tasks first");
  });

  it("draws the ledger skeleton while nothing has arrived", () => {
    const h = ledger({ settling: true, groups: [] });
    expect(subtree(h, "usage-settling-ledger")).toContain('aria-label="Loading the ledger"');
    expect(h).not.toContain('data-testid="usage-find"');
  });
});

/* ══ the controls govern the read ══════════════════════════════════════ */

describe("what the pane asks the server for", () => {
  /**
   * **The query key is the request**, so this is the whole of "the controls
   * narrow it": the period, the scope, the grouping, the second level, the
   * sort, the search and the page size all go into it, which is what makes
   * changing one of them a different read rather than a different filter over
   * the same answer.
   */
  it("is exactly what its controls say, and nothing it was not asked", () => {
    const params = asked({ answer: FULL });
    expect(params).toEqual({
      from: periodOf("d14", new Date()).from,
      to: periodOf("d14", new Date()).to,
      bucket: "day",
      group: "task",
      sort: "tokens",
      direction: "desc",
      limit: 25,
    });
    // No scope and no search while neither has been narrowed — an empty
    // `find` on the wire is a different request from no find at all.
    expect(params).not.toHaveProperty("person");
    expect(params).not.toHaveProperty("team");
    expect(params).not.toHaveProperty("find");
    expect(params).not.toHaveProperty("then");
  });

  /** A day of columns for a fortnight, a week for a quarter, a month for a
   *  year — the segment picks the bucket as well as the period. */
  it("asks for a period a chart can hold, and buckets it to match", () => {
    const params = asked({ answer: FULL });
    const days = (new Date(params.to as string).getTime() - new Date(params.from as string).getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(14);
    expect(params.bucket).toBe("day");
  });

  /**
   * And an answer filed under any other set of parameters is **not drawn**,
   * which is the other half: a pane that fell back to whatever was in the
   * cache would show last month's chart under this month's heading.
   */
  it("draws nothing from an answer filed under another period", () => {
    const h = draw({ answer: FULL, params: asks({ bucket: "week", from: "2020-01-01T00:00:00.000Z" }) });
    expect(h).toContain('data-testid="usage-settling"');
    expect(h).not.toContain('data-testid="usage-row-FIRE-412"');
  });

  it("draws nothing from an answer filed under another scope", () => {
    const h = draw({ answer: FULL, params: asks({ person: "me" }) });
    expect(h).toContain('data-testid="usage-settling"');
    expect(h).not.toContain('data-testid="usage-row-FIRE-412"');
  });

  it("draws nothing from an answer filed under a search it is not making", () => {
    const h = draw({ answer: FULL, params: asks({ find: "renderer" }) });
    expect(h).toContain('data-testid="usage-settling"');
    expect(h).not.toContain('data-testid="usage-row-FIRE-412"');
  });

  /** The reading and the ledger both come off the one read, so both follow. */
  it("draws the reading and the ledger from the one answer it asked for", () => {
    const quiet: Consumption = {
      ...FULL,
      totals: { ...TOTALS, tokens: 11_000 },
      series: COLUMNS.slice(0, 2),
      groups: [ROWS[0]],
      groupCount: 1,
    };
    const h = draw({ answer: quiet });
    expect(subtree(h, "usage-total")).toContain("11K");
    expect(h).toContain('data-testid="usage-row-FIRE-412"');
    expect(h).not.toContain('data-testid="usage-row-FIRE-418"');
    expect(draw({ answer: FULL })).toContain('data-testid="usage-row-FIRE-418"');
  });
});

/* ══ every state the contract names ════════════════════════════════════ */

describe("the states", () => {
  /** Skeletons at the real geometry, and **no axis, no gridline, no zero**. */
  it("settles into the shape of what is coming, and draws no chart", () => {
    const h = draw();
    expect(h).toContain('data-testid="usage-settling"');
    expect(h).toContain('aria-label="Loading usage"');
    expect(h).toContain('data-testid="usage-settling-ledger"');
    expect(h).toContain('aria-label="Loading the ledger"');
    expect(h).not.toContain('data-testid="usage-chart"');
    expect(h).not.toContain("crispEdges");
  });

  /** A read worked and returned nothing. A different answer from a failure,
   *  so it says so in words. */
  it("says nothing ran, and drops the ledger rather than heading an empty one", () => {
    const h = draw({ answer: { ...FULL, totals: { ...TOTALS, tokens: 0, rows: 0 }, series: [], groups: [], groupCount: 0 } });
    const blank = subtree(h, "usage-empty");
    expect(blank).toContain("Nothing ran in this period.");
    expect(blank).toContain("Widen the range above, or change who it covers.");
    expect(h).not.toContain('data-testid="usage-ledger"');
    expect(h).not.toContain('data-testid="usage-chart"');
  });

  /**
   * **A search that matches nothing keeps the reading**, and that is a fact
   * about the server rather than a choice: `find` is bound into the groups
   * query alone — the totals and the series carry the period — so the chart
   * above a failed search is still true and what is empty is the list.
   *
   * An answer with rows but no groups is exactly that case, and the pane
   * draws the reading over a ledger that says why it has nothing. (The note
   * itself needs the search to have been typed, which a static render cannot
   * do; it is driven through `Ledger` above.)
   */
  it("keeps the reading when the groups came back empty but the period did not", () => {
    const h = draw({ answer: { ...FULL, groups: [], groupCount: 0 } });
    expect(h).toContain('data-testid="usage-chart"');
    expect(h).toContain('data-testid="usage-ledger"');
    expect(h).not.toContain('data-testid="usage-empty"');
  });

  it("draws a failure in the body's place, and takes the controls with it", () => {
    const h = draw({ failed: { status: 500 } });
    const blank = subtree(h, "usage-error");
    expect(blank).toContain("That did not load");
    expect(blank).toContain("A long period over a lot of history can take longer than the connection will wait. Try again, or narrow the period above.");
    expect(subtree(h, "usage-retry")).toContain("Try again");
    // Narrowing a list nobody can read is not a thing to offer.
    expect(h).not.toContain('data-testid="usage-period"');
    expect(h).not.toContain('data-testid="usage-scope"');
    expect(h).not.toContain('data-testid="usage-ledger"');
  });

  /**
   * **`denied` is deliberately absent.** Consumption has no role gate on the
   * server, so a 403 here is a bug — and a lock would tell a member something
   * false about their own access. Retryable, and nothing untrue, instead.
   */
  it("draws a refusal as a failure, never as a lock", () => {
    const h = draw({ failed: { status: 403 } });
    expect(h).toContain('data-testid="usage-error"');
    expect(h).toContain("That did not load");
    expect(h).not.toContain("You cannot see this");
    expect(h).toContain('data-testid="usage-retry"');
  });

  /** Rows from a server that is not answering do not disappear. */
  it("keeps the last-known pane when nothing is answering", () => {
    const h = draw({ failed: {} });
    expect(subtree(h, "usage-dark")).toContain("Showing what was last known.");
    expect(h).toContain("stale2");
    // And the controls stay, unlike a failure: there is something to operate.
    expect(h).toContain('data-testid="usage-period"');
  });

  /** A one-person installation on its first day is useful rather than empty. */
  it("draws a single item as a pane rather than as an edge case", () => {
    const one: Consumption = {
      totals: { ...TOTALS, tokens: 1_000, workspaces: 1, conversations: 1, tasks: 1, people: 1, turns: 1, rows: 1, unreportedTurns: 0 },
      series: [{ start: COLUMNS[0].start, models: [{ model: MODELS[0], tokens: 1_000 }] }],
      groups: [group({ key: "FIRE-412", name: "The first one", tokens: 1_000, models: [{ model: MODELS[0], tokens: 1_000 }] })],
      groupCount: 1,
    };
    const h = draw({ answer: one });
    expect(h).toContain('data-testid="usage-chart"');
    expect(h).toContain('data-testid="usage-row-FIRE-412"');
    // No key: one hue mapping one name is not a key.
    expect(h).not.toContain('data-testid="usage-key"');
    expect(subtree(h, "usage-figure-people")).toContain("Ran an agent in this period.");
  });

  /**
   * **Plain text, not a greyed button.** Somebody holding no directory grant
   * can only see their own work, so every row of the scope menu would name
   * the same set — and a disabled control is how an interface says you are
   * being withheld from.
   */
  it("states a fixed scope instead of offering a menu that cannot move", () => {
    const h = draw({ answer: FULL, directories: [] });
    const fixed = subtree(h, "usage-scope-fixed");
    expect(fixed).toContain("Just your own work");
    expect(fixed).toContain("You have not been granted anything beyond your own root, so there is nothing else to show.");
    expect(fixed).not.toContain("<button");
    expect(fixed).not.toContain("disabled");
    expect(h).not.toContain('data-testid="usage-scope"');
    // And the period still governs: only the scope has nowhere to go.
    expect(h).toContain('data-testid="usage-period"');
  });

  /** Nothing at all is a real answer, and it is drawn as nothing. */
  it("draws no Limits section when no subscription reported a ceiling", () => {
    const h = draw({ answer: FULL, accounts: [] });
    expect(h).not.toContain('data-testid="usage-limits"');
    expect(h).not.toContain(">Limits<");
  });
});

/* ══ Limits, last ══════════════════════════════════════════════════════ */

describe("Limits", () => {
  const html = () => draw({ answer: FULL });

  /**
   * **It is the only section that ignores the scope and the period**, and a
   * section that does not answer the controls must not sit between two that
   * do — the first thing that would teach a weekly reader is that changing
   * the period sometimes does nothing.
   */
  it("comes after the ledger, not between the reading and it", () => {
    const h = html();
    expect(h.indexOf('data-testid="usage-ledger"')).toBeGreaterThan(h.indexOf('data-testid="usage-pane"'));
    expect(h.indexOf('data-testid="usage-limits"')).toBeGreaterThan(h.indexOf('data-testid="usage-ledger"'));
  });

  it("says whose clock it is on", () => {
    expect(subtree(html(), "usage-limits")).toContain(
      "What each provider last told us about its own ceiling, on the provider’s clock. Not the period above.",
    );
  });

  it("names a subscription once, however many ways it is metered", () => {
    const lim = subtree(html(), "usage-limit-acc_kevin");
    expect(lim).toContain("Anthropic — kevin");
    expect(lim).toContain("u/kevin");
    expect((lim.match(/Anthropic — kevin/g) ?? []).length).toBe(1);
    expect(lim).toContain('data-testid="usage-limit-acc_kevin-five_hour"');
    expect(lim).toContain('data-testid="usage-limit-acc_kevin-seven_day"');
    expect(lim).toContain("5-hour window");
    expect(lim).toContain("68% used");
  });

  /** **No meter at all is the finding, not a gap to fill.** */
  it("draws a track only where a percentage was reported", () => {
    const h = html();
    expect(h).toContain('data-testid="usage-limit-meter-acc_kevin-five_hour"');
    expect(h).not.toContain('data-testid="usage-limit-meter-acc_ops-account"');
    expect(subtree(h, "usage-limit-acc_ops-account")).toContain("this agent reports no percentage");
  });

  /** Coloured by the number, not by the word beside it — and never ember. */
  it("colours a gauge from its percentage", () => {
    const h = html();
    expect(subtree(h, "usage-limit-acc_kevin-five_hour")).toContain("text-sage");
    expect(h).not.toContain("--color-ember");
  });

  it("offers an order only when there is more than one subscription", () => {
    expect(html()).toContain('data-testid="usage-limits-order"');
    expect(draw({ answer: FULL, accounts: [ACCOUNTS[0]] })).not.toContain('data-testid="usage-limits-order"');
  });
});

/* ══ what is replaced while a read is in flight ════════════════════════ */

describe("a read in flight", () => {
  /**
   * The chart and the figures depend on the period and the scope and on
   * nothing else, so a new sort keeps them and a new period replaces them.
   * The rule is `readState`; this is the pane asking it.
   */
  it("replaces the reading when the period changed, and keeps the rows", () => {
    const h = draw({ answer: FULL, fetching: true });
    expect(h).toContain('data-testid="usage-settling"');
    // The ledger keeps the previous rows, visibly stale.
    expect(h).toContain('data-testid="usage-row-FIRE-412"');
    expect(h).toContain("dimmed");
  });

  it("asks the rule rather than deciding again inline", () => {
    const of = (over: Partial<Parameters<typeof readState>[0]>) =>
      readState({ pending: false, fetching: false, has: true, showing: "a", wants: "a", ...over });
    expect(of({ pending: true })).toBe("settling");
    expect(of({ fetching: true, wants: "b" })).toBe("stale");
    expect(of({ fetching: true })).toBe("refetching");
    expect(of({})).toBe("ready");
    // A first read that has landed but has no previous answer behind it is
    // still settling rather than stale.
    expect(of({ pending: true, fetching: true, has: false, showing: "", wants: "b" })).toBe("settling");
  });
});
