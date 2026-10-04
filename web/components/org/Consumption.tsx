"use client";

/**
 * What the fleet spent, and on what.
 *
 * The page answers two questions that are not the same: "what did this feature
 * cost me", which is a developer's and is grouped by task, and "where is the
 * money going", which is an administrator's and is grouped by person or
 * directory. One ledger, cut either way — so the grouping controls sit on the
 * ledger rather than at the top of the page, because they change that and
 * nothing above it.
 *
 * **Access is not a mode.** There is one page, and what differs between an
 * owner and a member is which rows come back: every read underneath is scoped
 * by `filed_where`, the same predicate as workspaces and secrets. Somebody with
 * no grant beyond their own root sees their own work and the scope control is
 * fixed, because there is nothing else for it to reach.
 *
 * **Colour means the model, always.** Changing the grouping changes the rows,
 * never the palette — a reader who learned that violet is Codex keeps it. Past
 * nine rows the tail is folded together rather than given a tenth hue.
 */
import { useMemo, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import { useConsumption } from "@/src/api/generated/consumption/consumption";
import { useListAccounts } from "@/src/api/generated/accounts/accounts";
import { useListColleagues, useListTeams } from "@/src/api/generated/access/access";
import type { Account, ByModel, Group, Limit } from "@/src/api/generated/model";
import { PageHead } from "@/components/ui";

/* ── the vocabulary ───────────────────────────────────────────────────── */

const RANGES = {
  d14: { label: "the last 14 days", days: 14, bucket: "day" },
  d90: { label: "the last 90 days", days: 90, bucket: "week" },
  m12: { label: "the last 12 months", days: 365, bucket: "month" },
} as const;
type RangeKey = keyof typeof RANGES;

const GROUPS = {
  task: "task",
  model: "model",
  person: "person",
  repository: "repository",
  tracker: "tracker",
  directory: "directory",
  subscription: "subscription",
  workspace: "workspace",
  conversation: "conversation",
} as const;
type GroupKey = keyof typeof GROUPS;

/** Which hue a model wears, decided once and kept. */
const SERIES = [
  "var(--color-series-1)",
  "var(--color-series-2)",
  "var(--color-series-3)",
  "var(--color-series-4)",
];
const FOLDED = "var(--color-mute)";

/* ── numbers people read ──────────────────────────────────────────────── */

const tokens = (n: number) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(1).replace(/\.0$/, "")}B`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`
      : n >= 1e3
        ? `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}K`
        : `${Math.round(n)}`;

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const count = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`) =>
  `${count(n)} ${n === 1 ? one : many}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* ── the page ─────────────────────────────────────────────────────────── */

type Scope = { kind: "all" } | { kind: "me" } | { kind: "team"; id: string; name: string } | { kind: "person"; id: string; name: string };

export function Consumption() {
  const [range, setRange] = useState<RangeKey>("d14");
  const [group, setGroup] = useState<GroupKey>("task");
  const [then, setThen] = useState<GroupKey | "">("");
  const [scope, setScope] = useState<Scope>({ kind: "all" });
  const [picking, setPicking] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [table, setTable] = useState(false);

  const { data: colleagues } = useListColleagues();
  const { data: teams } = useListTeams();
  const { data: accounts } = useListAccounts();

  // Rounded to the day so the query key is stable across renders — otherwise
  // every tick of the clock is a new request for the same answer.
  const { from, to } = useMemo(() => {
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    const start = new Date(end);
    start.setDate(start.getDate() - (RANGES[range].days - 1));
    start.setHours(0, 0, 0, 0);
    return { from: start.toISOString(), to: end.toISOString() };
  }, [range]);

  const { data, isPending, isError } = useConsumption({
    from,
    to,
    bucket: RANGES[range].bucket,
    group,
    ...(then ? { then } : {}),
    ...(scope.kind === "me" ? { person: "me" } : {}),
    ...(scope.kind === "person" ? { person: scope.id } : {}),
    ...(scope.kind === "team" ? { team: scope.id } : {}),
  });

  // One hue per model, assigned by how much it did over the whole period, so a
  // filter that drops a model never repaints the ones that are left.
  const hue = useMemo(() => {
    const total = new Map<string, number>();
    for (const column of data?.series ?? [])
      for (const m of column.models) total.set(m.model, (total.get(m.model) ?? 0) + m.tokens);
    const ordered = [...total.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
    return (model: string) => {
      const at = ordered.indexOf(model);
      return at >= 0 && at < SERIES.length ? SERIES[at] : FOLDED;
    };
  }, [data]);

  const models = useMemo(() => {
    const seen = new Map<string, number>();
    for (const column of data?.series ?? [])
      for (const m of column.models) seen.set(m.model, (seen.get(m.model) ?? 0) + m.tokens);
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
  }, [data]);

  // The server orders each bucket's models by what they did in that bucket,
  // which is right for a list and wrong for a stack: the segments would
  // reshuffle from one column to the next and the chart would read as noise.
  // One order for the whole page instead.
  const inOrder = useMemo(() => {
    const rank = new Map(models.map((m, i) => [m, i]));
    return (list: ByModel[]) =>
      [...list].sort((a, b) => (rank.get(a.model) ?? 99) - (rank.get(b.model) ?? 99));
  }, [models]);

  const t = data?.totals;
  const everyone = scopeName(scope);

  return (
    <div className="pb-16">
      <PageHead eyebrow="Organization" title="Consumption">
        What the agents spent, and on what. Figures are for the period and scope below.
      </PageHead>

      {/* The sentence is the control. One word opens a search, because a row of
          buttons stops working at the second team. */}
      <p className="relative mb-7 text-title text-dim">
        <button
          type="button"
          className="border-b border-dotted border-mute pb-px text-bone transition-colors hover:border-bone"
          onClick={() => setPicking((p) => !p)}
          aria-haspopup="listbox"
          aria-expanded={picking}
        >
          {everyone}
        </button>
        {picking && (
          <ScopePicker
            colleagues={colleagues ?? []}
            teams={teams ?? []}
            onPick={(s) => {
              setScope(s);
              setPicking(false);
              if (s.kind !== "all" && group === "person") setGroup("task");
            }}
            onClose={() => setPicking(false)}
          />
        )}
        {", over "}
        <button
          type="button"
          className="border-b border-dotted border-mute pb-px text-bone transition-colors hover:border-bone"
          onClick={() =>
            setRange((r) => (r === "d14" ? "d90" : r === "d90" ? "m12" : "d14"))
          }
        >
          {RANGES[range].label}
        </button>
      </p>

      {isError && (
        <p className="text-ui text-brick">
          That didn&apos;t load. Reload the page, or narrow the period if it is a long one.
        </p>
      )}

      {/* ── the reading ────────────────────────────────────────────────── */}
      <section className={isPending ? "opacity-50 transition-opacity" : "transition-opacity"}>
        <div className="flex items-end justify-end">
          <div>
            <div className="font-narrow text-[64px] font-semibold leading-[0.86] tracking-[-0.025em] text-bone">
              {t ? tokens(t.tokens) : "—"}
            </div>
            <div className="mt-1.5 text-right text-ui text-dim">billed tokens</div>
          </div>
        </div>

        <Trace columns={data?.series ?? []} bucket={RANGES[range].bucket} hue={hue} order={inOrder} />

        <div className="mt-6 flex flex-wrap border-t border-line">
          <Figure
            label="Estimated cost"
            value={t?.costUsd != null ? `~${money(t.costUsd)}` : "Not reported"}
            note={
              t && t.rows > 0
                ? `Known for ${count(t.pricedRows)} of ${count(t.rows)} rows. Codex reports no price.`
                : ""
            }
          />
          <Figure
            label="Read from cache"
            value={t && t.tokens > 0 ? `${Math.round((t.cacheReadTokens / t.tokens) * 100)}%` : "—"}
            note="Of everything billed. Cheap tokens, but tokens."
          />
          <Figure
            label="Turns"
            value={t ? count(t.turns) : "—"}
            note={
              t
                ? `Across ${plural(t.conversations, "conversation")} in ${plural(t.workspaces, "workspace")}.`
                : ""
            }
          />
        </div>
      </section>

      <Limits accounts={accounts ?? []} />

      {/* ── the ledger ─────────────────────────────────────────────────── */}
      <section className="mt-12">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <h2 className="text-title font-semibold text-bone">
              Where it went, by {GROUPS[group]}
              {then ? ` and then by ${GROUPS[then]}` : ""}
            </h2>
            <p className="mt-0.5 text-meta text-mute">
              One ledger, sliced. Colour always means the model, whatever the rows are.
            </p>
          </div>
          <div className="flex items-center gap-2 pb-4">
            <Picker
              value={group}
              exclude={then}
              prefix="by"
              onChange={(v) => {
                // The outer picker never offers "nothing", but the shared type
                // allows it, so the guard is said once here rather than cast.
                if (!v) return;
                setGroup(v);
                if (v === then) setThen("");
                setOpen(null);
              }}
            />
            <Picker
              value={then}
              exclude={group}
              prefix="then by"
              allowNone
              onChange={(v) => {
                setThen(v);
                setOpen(null);
              }}
            />
            <button
              type="button"
              className="rounded-sm bg-raise px-2.5 py-1.5 text-ui text-dim transition-colors hover:bg-overlay hover:text-bone disabled:opacity-35"
              disabled={!then}
              title="Swap the two levels. The totals do not move."
              aria-label="Swap the two levels"
              onClick={() => {
                if (!then) return;
                const outer = group;
                setGroup(then);
                setThen(outer);
                setOpen(null);
              }}
            >
              ⇅
            </button>
          </div>
        </div>

        <Key models={models} hue={hue} />

        <div className="grid grid-cols-[minmax(0,1fr)_150px_78px_90px] gap-5 border-b border-line pb-2 text-meta text-mute">
          <div className="capitalize">{GROUPS[group]}</div>
          <div />
          <div className="text-right">Tokens</div>
          <div className="text-right">Cost</div>
        </div>

        <Ledger
          groups={data?.groups ?? []}
          by={group}
          nested={!!then}
          open={open}
          onOpen={setOpen}
          hue={hue}
          order={inOrder}
        />

        <button
          type="button"
          className="mt-6 border-b border-dotted border-mute text-meta text-dim transition-colors hover:border-bone hover:text-bone"
          onClick={() => setTable((v) => !v)}
          aria-expanded={table}
        >
          {table ? "Hide the table" : "Show every value as a table"}
        </button>
        {table && <Table groups={data?.groups ?? []} by={group} models={models} />}
      </section>
    </div>
  );
}

function scopeName(scope: Scope) {
  if (scope.kind === "me") return "Just me";
  if (scope.kind === "team" || scope.kind === "person") return scope.name;
  // Not "everyone in the organisation": the rows underneath are already
  // filtered to what this person was granted, so promising more would be a lie
  // on any account that has less.
  return "Everyone I can see";
}

/* ── limits ───────────────────────────────────────────────────────────── */

/**
 * What each provider last told us about its own ceiling.
 *
 * A different book from everything above it, and deliberately not joined to it:
 * a limit is the provider's accounting on the provider's clock, and it cannot
 * be worked out from the tokens we counted. Which is why this ignores the
 * period and the scope — there is no such thing as last month's limit.
 *
 * Claude Code reports no percentage, so those rows get no meter. The empty
 * space is the finding, not a gap to fill with a word-shaped box.
 */
function Limits({ accounts }: { accounts: Account[] }) {
  const [all, setAll] = useState(false);

  const rows = accounts.flatMap((a) =>
    (a.limits ?? []).map((l) => ({ account: a, limit: l })),
  );
  if (!rows.length) return null;

  const pressing = (l: Limit) => l.status !== "allowed";
  // Everything in trouble, plus your own. On an installation with a dozen
  // subscriptions the rest is a sentence, not fourteen rows nobody reads.
  const shown = all ? rows : rows.filter((r) => pressing(r.limit) || r.account.isDefault);
  const hidden = rows.length - shown.length;

  return (
    <section className="mt-12">
      <h2 className="text-title font-semibold text-bone">Limits</h2>
      <p className="mb-4 mt-0.5 text-meta text-mute">
        What each provider last told us. Not something we can work out from the tokens above, and
        not affected by the period.
      </p>

      <div className="grid gap-x-10 gap-y-4 sm:grid-cols-2">
        {(shown.length ? shown : rows).map(({ account, limit }) => (
          <Gauge key={`${account.id}:${limit.scope}`} account={account} limit={limit} />
        ))}
      </div>

      {(hidden > 0 || all) && (
        <button
          type="button"
          className="mt-5 border-b border-dotted border-mute text-meta text-dim transition-colors hover:border-bone hover:text-bone"
          onClick={() => setAll((v) => !v)}
        >
          {all
            ? "Show only the ones that need attention"
            : `${plural(hidden, "other window is", "other windows are")} allowed, with room to spare`}
        </button>
      )}
    </section>
  );
}

const TONE: Record<string, { text: string; bar: string }> = {
  allowed: { text: "text-sage", bar: "var(--color-sage)" },
  blocked: { text: "text-brick", bar: "var(--color-brick)" },
  rejected: { text: "text-brick", bar: "var(--color-brick)" },
};
const AMBER = { text: "text-amber", bar: "var(--color-amber)" };

/** `five_hour` is how an agent spells it; nobody says that out loud. */
const window_ = (scope: string) =>
  scope === "five_hour"
    ? "5-hour window"
    : scope === "account"
      ? "this account"
      : scope.replace(/_/g, " ");

/** "in 1 h 12 m", from the unix second an agent reported. */
function resets(at?: number | null) {
  if (!at) return null;
  const left = at * 1000 - Date.now();
  if (left <= 0) return "due to reset";
  const mins = Math.round(left / 60000);
  if (mins < 60) return `resets in ${mins} m`;
  return `resets in ${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, "0")} m`;
}

function Gauge({ account, limit }: { account: Account; limit: Limit }) {
  const tone = TONE[limit.status] ?? AMBER;
  const pct = limit.usedPercent;
  const when = resets(limit.resetsAt);

  return (
    <div className="min-w-0 max-w-[430px]">
      <div className="flex items-baseline gap-2">
        <span className="truncate text-ui text-bone">{account.name}</span>
        <span className="whitespace-nowrap text-meta text-mute">{window_(limit.scope)}</span>
        <span className="flex-1" />
        <span className={`whitespace-nowrap text-meta ${tone.text} ${pct != null ? "tabular-nums" : ""}`}>
          {pct != null ? `${pct}% used` : capitalise(limit.status)}
        </span>
      </div>

      {pct != null && (
        <div className="mt-2 h-[3px] overflow-hidden rounded-[2px]"
          style={{ background: `color-mix(in srgb, ${tone.bar} 20%, var(--color-ground))` }}>
          <div className="h-full rounded-[2px]"
            style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: tone.bar }} />
        </div>
      )}

      <div className="mt-1.5 text-meta text-mute">
        {pct == null && limit.status === "allowed"
          ? "This agent reports no percentage, so there is no meter to draw."
          : when ?? "No reset time reported."}
      </div>
    </div>
  );
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/* ── pieces ───────────────────────────────────────────────────────────── */

function Figure({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="min-w-0 flex-1 basis-56 px-5 pb-0.5 pt-3 first:pl-0 [&+&]:border-l [&+&]:border-line">
      <div className="text-meta text-dim">{label}</div>
      <div className="mt-0.5 font-narrow text-[25px] font-semibold leading-tight tracking-[-0.01em] text-bone">
        {value}
      </div>
      <div className="mt-1 max-w-[30ch] text-meta text-mute">{note}</div>
    </div>
  );
}

function Key({ models, hue }: { models: string[]; hue: (m: string) => string }) {
  if (models.length < 2) return null;
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1 pb-4">
      {models.map((m) => (
        <span key={m} className="inline-flex items-center gap-2 text-meta text-dim">
          <i className="block size-2 rounded-[2px]" style={{ background: hue(m) }} />
          {m}
        </span>
      ))}
    </div>
  );
}

/** A nice round ceiling that halves cleanly, so the two gridlines read. */
function ceiling(v: number) {
  if (!v) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const s of [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10]) if (v <= s * p) return s * p;
  return 10 * p;
}

function Trace({
  columns,
  bucket,
  hue,
  order,
}: {
  columns: { start: string; models: ByModel[] }[];
  bucket: string;
  hue: (m: string) => string;
  order: (list: ByModel[]) => ByModel[];
}) {
  const W = 1004;
  const TOP = 10;
  const BOTTOM = 196;
  const totals = columns.map((c) => c.models.reduce((a, m) => a + m.tokens, 0));
  const max = ceiling(Math.max(1, ...totals));
  const band = columns.length ? W / columns.length : W;
  const bar = Math.min(26, Math.max(5, band * 0.42));
  const y = (v: number) => BOTTOM - (v / max) * (BOTTOM - TOP);
  const sparse = columns.length > 16;

  const label = (iso: string) => {
    const d = new Date(iso);
    if (bucket === "month") return MONTHS[d.getMonth()];
    return `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, "0")}`;
  };

  return (
    <svg viewBox={`0 0 ${W} 232`} className="mt-1 block h-auto w-full overflow-visible" role="img"
      aria-label={`Billed tokens per ${bucket}, split by model.`}>
      {[0.5, 1].map((f) => {
        const at = Math.round(y(max * f)) + 0.5;
        return (
          <g key={f}>
            <line x1={0} x2={W} y1={at} y2={at} stroke="var(--color-grid, #1c1c20)" strokeWidth={1} shapeRendering="crispEdges" />
            <text x={0} y={at - 6} className="fill-mute text-[11px] tabular-nums">{tokens(max * f)}</text>
          </g>
        );
      })}
      <line x1={0} x2={W} y1={Math.round(y(0)) + 0.5} y2={Math.round(y(0)) + 0.5}
        stroke="var(--color-line)" strokeWidth={1} shapeRendering="crispEdges" />

      {columns.map((column, i) => {
        const x = i * band + (band - bar) / 2;
        const live = order(column.models).filter((m) => m.tokens > 0);
        let cursor = y(0);
        return (
          <g key={column.start}>
            <title>{`${label(column.start)}: ${tokens(totals[i])} tokens`}</title>
            {live.map((m, n) => {
              const h = (m.tokens / max) * (BOTTOM - TOP);
              const bottom = cursor;
              const top = cursor - h;
              cursor = top;
              const last = n === live.length - 1;
              // The 2px gap separates; it does not tax. A segment smaller than
              // the gap keeps its height, or a quiet day renders as stripes.
              const drawn = last ? h : h > 4 ? h - 2 : h;
              const r = last ? Math.min(3, h / 2, bar / 2) : 0;
              return (
                <rect key={m.model} x={x} y={top} width={bar} height={Math.max(1, drawn)}
                  rx={r} ry={r} fill={hue(m.model)} />
              );
            })}
            {(!sparse || i % 2 === 1) && (
              <text x={x + bar / 2} y={BOTTOM + 19} textAnchor="middle" className="fill-mute text-[11px] tabular-nums">
                {label(column.start)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** The sub-line under a row, in the terms that dimension is actually about. */
function detail(g: Group, by: GroupKey) {
  switch (by) {
    case "task":
      return `${plural(g.workspaces, "workspace")}, ${plural(g.conversations, "conversation")}`;
    case "person":
      return `${plural(g.tasks, "task")}, ${plural(g.conversations, "conversation")}`;
    case "model":
    case "subscription":
      return `${plural(g.people, "person", "people")}, ${plural(g.turns, "turn")}`;
    case "workspace":
    case "conversation":
      return plural(g.turns, "turn");
    default:
      return `${plural(g.tasks, "task")}, ${plural(g.people, "person", "people")}`;
  }
}

function Ledger({
  groups,
  by,
  nested,
  open,
  onOpen,
  hue,
  order,
}: {
  groups: Group[];
  by: GroupKey;
  nested: boolean;
  open: string | null;
  onOpen: (k: string | null) => void;
  hue: (m: string) => string;
  order: (list: ByModel[]) => ByModel[];
}) {
  if (!groups.length)
    return (
      <p className="py-5 text-ui text-mute">
        Nothing ran in this period. Widen the range, or change the scope.
      </p>
    );

  const top = groups.slice(0, 9);
  const rest = groups.slice(9);
  // The folded tail is a remainder, not an entity: it gets no bar, and it does
  // not set the scale — nine folded rows would otherwise flatten every real one.
  const max = Math.max(...top.map((g) => g.tokens), 1);

  return (
    <div>
      {top.map((g) => {
        const id = g.key ?? "∅";
        return (
          <div key={id}>
            <Line g={g} by={by} scale={max} hue={hue} order={order} openable={nested}
              expanded={open === id} onToggle={() => onOpen(open === id ? null : id)} />
            {nested && open === id && !!g.children?.length && (
              <div className="bg-panel">
                {g.children.slice(0, 6).map((c) => (
                  <Line key={c.key ?? "∅"} g={c} by={by} nested order={order}
                    scale={Math.max(...g.children!.map((x) => x.tokens), 1)} hue={hue} />
                ))}
                {g.children.length > 6 && (
                  <p className="px-4 pb-2.5 pt-0.5 text-meta text-mute">
                    {g.children.length - 6} more, not shown
                  </p>
                )}
              </div>
            )}
            {nested && open === id && !g.children?.length && (
              <p className="bg-panel px-4 py-2.5 text-meta text-mute">
                A second level is only cut for a grouping that can be narrowed. Group by person
                first, then by anything.
              </p>
            )}
          </div>
        );
      })}
      {rest.length > 0 && (
        <div className="grid grid-cols-[minmax(0,1fr)_150px_78px_90px] items-center gap-5 border-b border-line-soft py-3">
          <div className="min-w-0">
            <div className="truncate text-body italic text-dim">
              {plural(rest.length, `smaller ${GROUPS[by]}`)}
            </div>
            <div className="mt-0.5 text-meta text-mute">
              folded in rather than given a tenth colour
            </div>
          </div>
          <div />
          <div className="text-right font-narrow text-[15px] font-medium tabular-nums text-text">
            {tokens(rest.reduce((a, g) => a + g.tokens, 0))}
          </div>
          <Cost g={{ costUsd: rest.reduce<number | null>((a, g) => (g.costUsd == null ? a : (a ?? 0) + g.costUsd), null) } as Group} />
        </div>
      )}
    </div>
  );
}

function Line({
  g,
  by,
  scale,
  hue,
  order,
  nested,
  openable,
  expanded,
  onToggle,
}: {
  g: Group;
  by: GroupKey;
  scale: number;
  hue: (m: string) => string;
  order: (list: ByModel[]) => ByModel[];
  nested?: boolean;
  openable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  // Children scale against their siblings but never reach the parent's length:
  // a child as long as its parent reads as equal to it.
  const span = nested ? 68 : 100;
  const width = Math.min(span, Math.max(4, (g.tokens / scale) * span));

  return (
    <div
      className={`grid grid-cols-[minmax(0,1fr)_150px_78px_90px] items-center gap-5 border-b py-3 ${
        nested ? "border-transparent pl-4" : "border-line-soft"
      } ${openable ? "cursor-pointer" : ""}`}
      onClick={openable ? onToggle : undefined}
      role={openable ? "button" : undefined}
      tabIndex={openable ? 0 : undefined}
      aria-expanded={openable ? expanded : undefined}
      onKeyDown={
        openable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onToggle?.();
              }
            }
          : undefined
      }
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          {openable && (
            <ChevronRight
              className={`size-3.5 shrink-0 text-mute transition-transform ${expanded ? "rotate-90" : ""}`}
            />
          )}
          <span className={`truncate ${nested ? "text-ui text-text" : "text-body"} ${g.name ? "text-bone" : "italic text-dim"}`}>
            {g.name ?? unnamed(g, by)}
          </span>
        </div>
        {!nested && (
          <div className="mt-0.5 flex items-baseline gap-3.5">
            {g.key && by === "task" && (
              <span className="truncate font-mono text-[11.5px] text-dim">{g.key}</span>
            )}
            <span className="whitespace-nowrap text-meta text-mute">{detail(g, by)}</span>
          </div>
        )}
      </div>
      <div className="min-w-0 overflow-hidden">
        <div className="flex gap-0.5" style={{ width: `${width}%`, height: nested ? 5 : 7 }}>
          {order(g.models).map((m) => (
            <i key={m.model} className="block h-full first:rounded-l-[2px] last:rounded-r-[2px]"
              style={{ flex: `0 0 ${(m.tokens / g.tokens) * 100}%`, background: hue(m.model) }} />
          ))}
        </div>
      </div>
      <div className={`text-right font-narrow font-medium tabular-nums text-text ${nested ? "text-[13px]" : "text-[15px]"}`}>
        {tokens(g.tokens)}
      </div>
      <Cost g={g} nested={nested} />
    </div>
  );
}

/** NULL is not zero, and a figure that is partly known says which part. */
function Cost({ g, nested }: { g: Group; nested?: boolean }) {
  if (g.costUsd == null)
    return <div className="text-right text-meta text-mute">not reported</div>;
  return (
    <div
      className={`text-right font-narrow font-medium tabular-nums text-dim ${nested ? "text-[13px]" : "text-[15px]"}`}
      title={
        g.rows && g.pricedRows < g.rows
          ? `Price known for ${count(g.pricedRows)} of ${count(g.rows)} rows`
          : undefined
      }
    >
      ~{money(g.costUsd)}
    </div>
  );
}

/** What to call a row the data could not name. */
function unnamed(g: Group, by: GroupKey) {
  if (by === "task") return g.key ? "Title unavailable" : "No task assigned";
  if (by === "tracker") return "No tracker";
  if (by === "subscription") return "No subscription";
  return g.key ?? "Unknown";
}

function Table({ groups, by, models }: { groups: Group[]; by: GroupKey; models: string[] }) {
  return (
    <div className="mt-6 overflow-x-auto">
      <table className="w-full border-collapse text-meta">
        <thead>
          <tr>
            <th className="border-b border-line pb-2 pr-3 text-left font-normal capitalize text-mute">
              {GROUPS[by]}
            </th>
            <th className="border-b border-line pb-2 pr-3 text-left font-normal text-mute">Key</th>
            {models.map((m) => (
              <th key={m} className="border-b border-line pb-2 pr-3 text-right font-normal text-mute">{m}</th>
            ))}
            <th className="border-b border-line pb-2 pr-3 text-right font-normal text-mute">Total</th>
            <th className="border-b border-line pb-2 text-right font-normal text-mute">Cost</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.key ?? "∅"}>
              <td className="border-b border-line-soft py-1.5 pr-3 text-bone">{g.name ?? unnamed(g, by)}</td>
              <td className="border-b border-line-soft py-1.5 pr-3 font-mono text-[11px] text-dim">{g.key ?? "—"}</td>
              {models.map((m) => {
                const hit = g.models.find((x) => x.model === m);
                return (
                  <td key={m} className="border-b border-line-soft py-1.5 pr-3 text-right tabular-nums">
                    {hit ? tokens(hit.tokens) : "—"}
                  </td>
                );
              })}
              <td className="border-b border-line-soft py-1.5 pr-3 text-right tabular-nums">{tokens(g.tokens)}</td>
              <td className="border-b border-line-soft py-1.5 text-right tabular-nums">
                {g.costUsd == null ? "not reported" : `~${money(g.costUsd)}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── controls ─────────────────────────────────────────────────────────── */

function Picker({
  value,
  exclude,
  prefix,
  allowNone,
  onChange,
}: {
  value: GroupKey | "";
  exclude: GroupKey | "";
  prefix: string;
  allowNone?: boolean;
  onChange: (v: GroupKey | "") => void;
}) {
  return (
    <select
      className="appearance-none rounded-sm bg-raise py-1.5 pl-2.5 pr-6 text-ui text-text transition-colors hover:bg-overlay"
      style={{
        backgroundImage:
          "linear-gradient(45deg,transparent 50%,var(--color-mute) 50%),linear-gradient(135deg,var(--color-mute) 50%,transparent 50%)",
        backgroundPosition: "calc(100% - 13px) 53%, calc(100% - 9px) 53%",
        backgroundSize: "4px 4px, 4px 4px",
        backgroundRepeat: "no-repeat",
      }}
      value={value}
      aria-label={prefix}
      onChange={(e) => onChange(e.target.value as GroupKey | "")}
    >
      {allowNone && <option value="">then by nothing</option>}
      {(Object.keys(GROUPS) as GroupKey[])
        .filter((k) => k !== exclude)
        .map((k) => (
          <option key={k} value={k}>
            {prefix} {GROUPS[k]}
          </option>
        ))}
    </select>
  );
}

/**
 * Who to narrow to.
 *
 * A search rather than a list, because a row of names stops working at the
 * second team and this installation may have two hundred people in it. The
 * ranked ledger below is still the way most people find somebody — this is the
 * escape hatch for when you already know who you want.
 */
function ScopePicker({
  colleagues,
  teams,
  onPick,
  onClose,
}: {
  colleagues: { id: string; username: string }[];
  teams: { id: string; name: string }[];
  onPick: (s: Scope) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const hits = (s: string) => !needle || s.toLowerCase().includes(needle);

  const people = colleagues.filter((c) => hits(c.username));
  const groups = teams.filter((t) => hits(t.name));
  const wide = [
    ...(hits("everyone") ? [{ label: "Everyone", scope: { kind: "all" } as Scope }] : []),
    ...(hits("just me") ? [{ label: "Just me", scope: { kind: "me" } as Scope }] : []),
  ];

  return (
    <>
      <div className="fixed inset-0 z-20" onClick={onClose} aria-hidden />
      <div className="absolute left-[-11px] top-[calc(100%+9px)] z-30 w-[290px] rounded-md bg-overlay p-[7px] shadow-float">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-mute" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search people and teams"
            aria-label="Search people and teams"
            className="mb-1 w-full rounded-sm bg-ground py-2 pl-8 pr-2.5 text-ui text-bone placeholder:text-mute"
            onKeyDown={(e) => e.key === "Escape" && onClose()}
          />
        </div>
        <div className="max-h-[286px] overflow-y-auto" role="listbox">
          {wide.length > 0 && <Heading>Scope</Heading>}
          {wide.map((w) => (
            <Option key={w.label} label={w.label} onPick={() => onPick(w.scope)} />
          ))}
          {groups.length > 0 && <Heading>Teams</Heading>}
          {groups.map((t) => (
            <Option key={t.id} label={t.name}
              onPick={() => onPick({ kind: "team", id: t.id, name: t.name })} />
          ))}
          {people.length > 0 && <Heading>People</Heading>}
          {people.map((c) => (
            <Option key={c.id} label={c.username} note={`u/${c.username}`}
              onPick={() => onPick({ kind: "person", id: c.id, name: c.username })} />
          ))}
          {!wide.length && !groups.length && !people.length && (
            <p className="px-2.5 py-3 text-meta text-mute">Nobody matches “{q}”.</p>
          )}
        </div>
      </div>
    </>
  );
}

const Heading = ({ children }: { children: React.ReactNode }) => (
  <div className="px-2.5 pb-1 pt-2 text-meta text-mute">{children}</div>
);

const Option = ({ label, note, onPick }: { label: string; note?: string; onPick: () => void }) => (
  <button type="button" role="option" aria-selected={false} onClick={onPick}
    className="flex w-full items-baseline gap-2 rounded-sm px-2.5 py-1.5 text-left text-ui text-text transition-colors hover:bg-raise hover:text-bone">
    <span className="truncate">{label}</span>
    {note && <span className="ml-auto whitespace-nowrap text-meta text-mute">{note}</span>}
  </button>
);
