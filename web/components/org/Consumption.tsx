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
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { keepPreviousData } from "@tanstack/react-query";
import { ArrowDown, ArrowDownUp, ArrowUp, ChevronRight, Search } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useConsumption } from "@/src/api/generated/consumption/consumption";
import { useListAccounts } from "@/src/api/generated/accounts/accounts";
import { useListColleagues, useListTeams } from "@/src/api/generated/access/access";
import type { Account, ByModel, Direction, Group, Limit, Sort, Totals } from "@/src/api/generated/model";
import { Choose, Icon, PageHead, useAnchor } from "@/components/ui";

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
  directory: "directory",
  subscription: "subscription",
  workspace: "workspace",
} as const;
type GroupKey = keyof typeof GROUPS;

/**
 * How to order the ledger.
 *
 * Five mean the same thing whatever is grouped. `breadth` is the one that
 * changes with it — a task sprawling across worktrees and a model reaching
 * people are both breadth, and neither is the other's column — so its label is
 * written per dimension below.
 *
 * `perTurn` is here because it answers a different question from `tokens`: a
 * task of forty cheap turns and one of four enormous ones look identical by
 * total, and only one of them is worth looking at.
 */
/**
 * `starts` is which way round a sort is worth reading first.
 *
 * Every other one answers "which is the biggest", so it opens descending. Name
 * does not — nobody looks up a list alphabetically from Z — so choosing it
 * starts at A, and the arrow beside it still reverses either.
 */
const SORTS: { value: Sort; field: string; up: string; down: string; starts: Direction }[] = [
  { value: "tokens",  field: "tokens",        down: "most tokens", up: "fewest tokens", starts: "desc" },
  { value: "cost",    field: "cost",          down: "most expensive", up: "least expensive", starts: "desc" },
  { value: "recent",  field: "last activity", down: "most recent", up: "oldest",        starts: "desc" },
  { value: "breadth", field: "",              down: "widest",      up: "narrowest",     starts: "desc" },
  { value: "name",    field: "name",          down: "Z to A",      up: "A to Z",        starts: "asc" },
];

/** What "breadth" counts, for each way of grouping. */
const BREADTH: Record<GroupKey, string> = {
  task: "workspaces",
  person: "tasks",
  model: "people",
  subscription: "people",
  repository: "tasks",
  directory: "tasks",
  workspace: "turns",
};

/** What a sort is called, in a sentence, for the direction button's label. */
function labelFor(sort: Sort, by: GroupKey, way: "up" | "down") {
  const o = SORTS.find((x) => x.value === sort);
  if (!o) return sort;
  if (sort === "breadth") return `${way === "down" ? "most" : "fewest"} ${BREADTH[by]}`;
  return o[way];
}

/** Where a list is long enough that finding beats ranking. */
const SEARCHABLE: GroupKey[] = ["task", "workspace"];

/**
 * Waits for typing to stop.
 *
 * A request per keystroke is a dozen queries to answer one question, each
 * racing the last — and on a table of millions the one that wins is whichever
 * finishes last, not whichever was asked last.
 */
function useDebounced<T>(value: T, ms: number) {
  const [settled, setSettled] = useState(value);
  const first = useRef(true);
  useEffect(() => {
    // The first value is already settled; waiting on it would delay the page.
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** A small action beside a control: one icon, no label of its own. */
function Nudge({
  icon,
  text,
  label,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  /** Said out loud beside the arrow, for the one where an arrow alone is a guess. */
  text?: string;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-8 items-center justify-center gap-1.5 rounded-md border border-line text-dim transition-colors duration-150 hover:border-mute/60 hover:text-bone disabled:cursor-not-allowed disabled:border-line disabled:text-mute/50 ${
        text ? "px-2.5" : "w-8"
      }`}
    >
      <Icon of={icon} size={12} />
      {text && <span className="text-meta font-semibold tracking-wide">{text}</span>}
    </button>
  );
}

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

// A part of a whole. Rounding is kept away from the two ends: a part that is
// there at all does not read as 0%, and one that is short of everything does
// not read as 100%, because either would deny what the breakdown is for.
const share = (n: number, of: number) => {
  if (of <= 0 || n === 0) return "";
  const pct = (n / of) * 100;
  if (pct < 1) return "<1%";
  if (pct > 99 && n < of) return ">99%";
  return `${Math.round(pct)}%`;
};

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
  const [tip, setTip] = useState<Tip | null>(null);
  const [sort, setSort] = useState<Sort>("tokens");
  const [direction, setDirection] = useState<Direction>("desc");
  // What is typed, and what has been asked for. Two states because they are
  // two things: the field has to answer every keystroke, and the server does
  // not — a request per character is a dozen queries to answer one question,
  // each one racing the last.
  const [typed, setTyped] = useState("");
  const find = useDebounced(typed, 300);
  const [limit, setLimit] = useState(25);

  // Measured from the trigger and drawn on `body`, the way every other menu in
  // the app is. Absolutely positioned inside the page, it scrolled away with
  // the paragraph it sat in — and because its own list hands the wheel back to
  // the page at either end, scrolling to look at it carried it off screen.
  const anchor = useAnchor(picking);
  const { data: colleagues } = useListColleagues();
  const { data: teams } = useListTeams();
  const { data: accounts, isPending: limitsPending } = useListAccounts();

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

  const { data, isPending, isFetching, isError, refetch } = useConsumption({
    from,
    to,
    bucket: RANGES[range].bucket,
    group,
    ...(then ? { then } : {}),
    ...(scope.kind === "me" ? { person: "me" } : {}),
    ...(scope.kind === "person" ? { person: scope.id } : {}),
    ...(scope.kind === "team" ? { team: scope.id } : {}),
    sort,
    direction,
    limit,
    ...(find.trim() ? { find: find.trim() } : {}),
  }, {
    // Changing the period, the sort or the grouping is a new query key, which
    // would otherwise empty the page and show skeletons again on every click.
    // Holding the last answer means the only blank state anybody sees is the
    // first one — after that the page dims and swaps, and never jumps.
    query: { placeholderData: keepPreviousData },
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

  /* ── which of five states the page is in ──────────────────────────────
     Nothing below may draw a chart with no data in it. An axis labelled "1"
     with no columns is what a failure looked like, and it reads as a product
     that is broken rather than one that is waiting or empty. */
  const scopeKey = `${scope.kind}:${"id" in scope ? scope.id : ""}`;
  const wants = `${range}|${scopeKey}`;
  const showing = useRef("");
  useEffect(() => {
    if (data && !isFetching) showing.current = wants;
  }, [data, isFetching, wants]);

  // The chart and the figures depend on the period and the scope, and on
  // nothing else — so a new sort keeps them, and a new period replaces them.
  // Holding the old ones would be worse than a skeleton: the sentence above
  // already says the new period, and a chart of the old one under it is a lie
  // rather than a stale answer.
  const staleReading = isFetching && !!data && showing.current !== wants;
  const empty = !!data && data.totals.rows === 0;

  // Any change to what is being listed starts again at the top. Keeping the
  // page number across a new sort shows somebody rows 26–50 of a list they
  // have not seen the beginning of.
  const reset = () => setLimit(25);
  const t = data?.totals;
  const everyone = scopeName(scope);

  return (
    <div className="pb-16">
      <PageHead eyebrow="Organization" title="Usage">
        What the agents spent, and on what. Figures are for the period and scope below.
      </PageHead>

      {/* The sentence is the control. One word opens a search, because a row of
          buttons stops working at the second team. */}
      <p className="mb-7 text-title text-dim">
        <button
          ref={anchor.trigger}
          type="button"
          className="border-b border-dotted border-mute pb-px text-bone transition-colors hover:border-bone"
          onClick={() => setPicking((p) => !p)}
          aria-haspopup="listbox"
          aria-expanded={picking}
        >
          {everyone}
        </button>
        {picking && anchor.at && (
          <ScopePicker
            at={anchor.at}
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

      {/* ── the reading ────────────────────────────────────────────────── */}
      <section
        className={`transition-opacity duration-200 ${
          isFetching && !isPending && !staleReading ? "opacity-50" : ""
        }`}
      >
        {isError ? (
          <Trouble onRetry={() => void refetch()} />
        ) : isPending || staleReading ? (
          <ReadingSkeleton />
        ) : empty ? (
          <Nothing
            why={
              find.trim()
                ? `Nothing matches “${find.trim()}” in this period.`
                : "Nothing ran in this period."
            }
            what="Widen the range above, or change who it covers."
          />
        ) : (
          <>
            {/* The total and the four numbers it is made of, as one object: the
                parts sit under the whole they are parts of, and the block is
                right-aligned so the chart underneath keeps the width. */}
            <div className="mb-7 flex justify-end">
              <div>
                <div className="text-right font-narrow text-[64px] font-semibold leading-[0.86] tracking-[-0.025em] text-bone">
                  {t ? tokens(t.tokens) : "—"}
                </div>
                <div className="mt-1.5 text-right text-ui text-dim">tokens processed</div>
                {t && t.tokens > 0 && <Composition t={t} />}
              </div>
            </div>

            <Trace columns={data?.series ?? []} bucket={RANGES[range].bucket} hue={hue}
              order={inOrder} onTip={setTip} />

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
                label="Turns"
                value={t ? count(t.turns) : "—"}
                note={
                  t
                    ? `Across ${plural(t.conversations, "conversation")} in ${plural(t.workspaces, "workspace")}.`
                    : ""
                }
              />
            </div>
          </>
        )}
      </section>

      <Limits accounts={accounts ?? []} pending={limitsPending} />

      {/* ── the ledger ─────────────────────────────────────────────────── */}
      <section className="mt-12">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <h2 className="text-title font-semibold text-bone">
              Where it went, by {GROUPS[group]}
              {then ? ` and then by ${GROUPS[then]}` : ""}
            </h2>
          </div>
          <div className="flex flex-wrap items-center gap-2 pb-4">
            <Choose
              label="Group by"
              value={group}
              options={(Object.keys(GROUPS) as GroupKey[])
                .filter((k) => k !== then)
                .map((k) => ({ value: k, label: `by ${GROUPS[k]}` }))}
              onChange={(v) => {
                setGroup(v);
                if (v === then) setThen("");
                if (!SEARCHABLE.includes(v)) setTyped("");
                setOpen(null);
                reset();
              }}
            />
            <Choose
              label="Then by"
              value={then}
              options={[
                { value: "" as GroupKey | "", label: "then by nothing" },
                // Directory is a place, not a thing that happens inside
                // another row: "this task, broken down by directory" is one
                // directory every time.
                ...(Object.keys(GROUPS) as GroupKey[])
                  .filter((k) => k !== group && k !== "directory")
                  .map((k) => ({ value: k as GroupKey | "", label: `then by ${GROUPS[k]}` })),
              ]}
              onChange={(v) => {
                setThen(v);
                setOpen(null);
              }}
            />
            <Nudge
              icon={ArrowDownUp}
              label="Swap the two levels. The totals do not move."
              disabled={!then}
              onClick={() => {
                if (!then) return;
                const outer = group;
                setGroup(then);
                setThen(outer);
                setOpen(null);
              }}
            />

            <span className="mx-1 h-5 w-px bg-line" aria-hidden />

            {/* The menu names what is being measured and nothing else; the
                button beside it names the direction, in words as well as an
                arrow. Both halves said a direction before, and there was no
                telling which one won. */}
            <Choose
              label="Sort by"
              value={sort}
              options={SORTS.map((o) => ({
                value: o.value,
                label: `sort by ${o.field || BREADTH[group]}`,
              }))}
              onChange={(v) => {
                setSort(v);
                setDirection(SORTS.find((o) => o.value === v)?.starts ?? "desc");
                setOpen(null);
                reset();
              }}
            />
            <Nudge
              icon={direction === "desc" ? ArrowDown : ArrowUp}
              text={direction === "desc" ? "DESC" : "ASC"}
              label={`${labelFor(sort, group, direction === "desc" ? "down" : "up")} first — click for ${labelFor(sort, group, direction === "desc" ? "up" : "down")}`}
              onClick={() => {
                setDirection((d) => (d === "desc" ? "asc" : "desc"));
                setOpen(null);
                reset();
              }}
            />
          </div>
        </div>

        {SEARCHABLE.includes(group) && (
          <div className="relative mb-4 max-w-[340px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-mute" />
            <input
              value={typed}
              onChange={(e) => {
                setTyped(e.target.value);
                reset();
              }}
              placeholder={`Find a ${GROUPS[group]}`}
              aria-label={`Find a ${GROUPS[group]}`}
              className="w-full rounded-sm bg-raise py-1.5 pl-8 pr-2.5 text-ui text-bone placeholder:text-mute"
            />
          </div>
        )}

        <Key models={models} hue={hue} />

        <div className="grid grid-cols-[minmax(0,1fr)_150px_78px_90px] gap-5 border-b border-line pb-2 text-meta text-mute">
          <div className="capitalize">{GROUPS[group]}</div>
          <div />
          <div className="text-right">Tokens</div>
          <div className="text-right">Cost</div>
        </div>

        <div className={`transition-opacity duration-200 ${isFetching && !isPending ? "opacity-50" : ""}`}>
        {isError ? null : isPending ? (
          <LedgerSkeleton />
        ) : (
        <Ledger
          groups={data?.groups ?? []}
          rest={data?.rest ?? undefined}
          total={data?.groupCount ?? 0}
          periodTokens={t?.tokens ?? 0}
          by={group}
          nested={!!then}
          open={open}
          onOpen={setOpen}
          hue={hue}
          order={inOrder}
          onTip={setTip}
        />
        )}
        </div>

        {!isPending && (data?.groupCount ?? 0) > limit && (
          <button
            type="button"
            className="mt-4 rounded-sm bg-raise px-3 py-1.5 text-ui text-text transition-colors hover:bg-overlay hover:text-bone"
            onClick={() => setLimit((n) => n + 25)}
          >
            Show 25 more
          </button>
        )}

      </section>

      <TipLayer tip={tip} hue={hue} order={inOrder} />
    </div>
  );
}

/* ── the states that are not a chart ──────────────────────────────────── */

/**
 * The read failed.
 *
 * Drawn in the chart's place rather than above it. A line of red over an axis
 * with no columns on it says "broken" twice and offers nothing to do about it;
 * this says what happened once and gives you the button.
 *
 * It keeps the block's height so the page below does not jump up to meet it.
 */
function Trouble({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-[320px] flex-col items-start justify-center gap-3 border-b border-line">
      <p className="text-ui text-text">That didn&apos;t load.</p>
      <p className="max-w-[46ch] text-meta text-mute">
        A long period over a lot of history can take longer than the connection will wait. Try
        again, or narrow the period above.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-1 rounded-md border border-line px-3 py-1.5 text-ui text-text transition-colors duration-150 hover:border-mute/60 hover:text-bone"
      >
        Try again
      </button>
    </div>
  );
}

/**
 * The read worked and there is nothing in it.
 *
 * A real answer, and a different one from a failure — so it says so in words
 * rather than drawing an empty chart and letting somebody wonder whether it is
 * still loading.
 */
function Nothing({ why, what }: { why: string; what: string }) {
  return (
    <div className="flex min-h-[320px] flex-col items-start justify-center gap-2 border-b border-line">
      <p className="text-ui text-text">{why}</p>
      <p className="max-w-[46ch] text-meta text-mute">{what}</p>
    </div>
  );
}

/* ── waiting ──────────────────────────────────────────────────────────── */

/**
 * What a page looks like before it has an answer.
 *
 * The shapes are the real ones: the figure sits where the figure sits, the
 * columns stand on the baseline, the rows are the row grid. A skeleton whose
 * geometry does not match what replaces it is a layout jump with extra steps,
 * and the jump is the thing it was supposed to prevent.
 *
 * Column heights are fixed rather than random, so a re-render does not make the
 * placeholder dance while somebody waits.
 */
const Block = ({ className = "", style }: { className?: string; style?: React.CSSProperties }) => (
  <div className={`settling ${className}`} style={style} aria-hidden />
);

const BARS = [34, 52, 41, 68, 57, 79, 62, 88, 71, 96, 83, 100];

function ReadingSkeleton() {
  return (
    <div role="status" aria-label="Loading usage">
      <div className="mb-7 flex justify-end">
        <div className="flex flex-col items-end">
          <Block className="h-[56px] w-[180px] rounded-md" />
          <Block className="mt-2.5 h-3 w-[86px]" />
          {/* The four parts, in their places. Widths differ because the numbers
              do — four identical bars promise a table rather than a list. */}
          <div className="mt-4 grid grid-cols-[auto_auto] gap-x-3 gap-y-2.5 border-t border-line pt-4">
            {[46, 54, 68, 62].map((n, i) => (
              <Fragment key={i}>
                <Block className="h-3.5 justify-self-end" style={{ width: n }} />
                <Block className="h-3.5" style={{ width: [38, 70, 112, 164][i] }} />
              </Fragment>
            ))}
          </div>
        </div>
      </div>

      {/* Standing on the baseline the real chart uses, so nothing moves. */}
      <div className="mt-1 flex h-[196px] items-end gap-[3.5%] border-b border-line pb-0">
        {BARS.map((h, i) => (
          <Block key={i} className="flex-1 rounded-t-[3px]" style={{ height: `${h}%` }} />
        ))}
      </div>
      <div className="mt-2.5 flex gap-[3.5%]">
        {BARS.map((_, i) => (
          <div key={i} className="flex flex-1 justify-center">
            <Block className="h-2.5 w-[70%]" />
          </div>
        ))}
      </div>

      <div className="mt-6 flex flex-wrap border-t border-line">
        {[0, 1].map((i) => (
          <div key={i} className="min-w-0 flex-1 basis-56 px-5 pb-0.5 pt-3 first:pl-0 [&+&]:border-l [&+&]:border-line">
            <Block className="h-3 w-[96px]" />
            <Block className="mt-2 h-[22px] w-[124px] rounded-sm" />
            <Block className="mt-2.5 h-2.5 w-[86%]" />
          </div>
        ))}
      </div>
    </div>
  );
}

function LedgerSkeleton() {
  return (
    <div role="status" aria-label="Loading the ledger">
      {Array.from({ length: 8 }, (_, i) => (
        <div
          key={i}
          className="grid grid-cols-[minmax(0,1fr)_150px_78px_90px] items-center gap-5 border-b border-line-soft py-3"
        >
          <div className="min-w-0">
            {/* Varied widths, because eight identical bars read as a table of
                one repeated thing rather than a list of different ones. */}
            <Block className="h-3.5" style={{ width: `${34 + ((i * 13) % 42)}%` }} />
            <Block className="mt-2 h-2.5" style={{ width: `${22 + ((i * 7) % 20)}%` }} />
          </div>
          <Block className="h-[7px] rounded-sm" style={{ width: `${100 - i * 9}%` }} />
          <Block className="ml-auto h-3.5 w-[52px]" />
          <Block className="ml-auto h-3.5 w-[64px]" />
        </div>
      ))}
    </div>
  );
}

/* ── the hover layer ──────────────────────────────────────────────────── */

type Tip = { x: number; y: number; head: string; models: ByModel[] };

/**
 * What a column or a row is made of, without having to open anything.
 *
 * On `body` and `fixed`, for the reason `Menu` gives: a tooltip opened from
 * inside a scrolling panel has to be placed against the viewport or it is drawn
 * in the wrong place the moment anything above it moves.
 *
 * It enhances and never gates — every number in here is also in the table
 * view, which is one click away and reachable without a pointer at all.
 */
function TipLayer({
  tip,
  hue,
  order,
}: {
  tip: Tip | null;
  hue: (m: string) => string;
  order: (list: ByModel[]) => ByModel[];
}) {
  if (!tip || typeof document === "undefined") return null;
  const rows = order(tip.models).filter((m) => m.tokens > 0);
  const total = rows.reduce((a, m) => a + m.tokens, 0);

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      style={{
        left: Math.min(Math.max(tip.x, 100), window.innerWidth - 100),
        top: Math.max(tip.y - 14, 96),
      }}
      className="pointer-events-none fixed z-[70] min-w-[186px] -translate-x-1/2 -translate-y-full rounded-md bg-overlay p-2.5 shadow-float"
    >
      <h3 className="mb-2 text-meta font-semibold text-bone">{tip.head}</h3>
      {rows.map((m) => (
        <div key={m.model} className="mt-1 grid grid-cols-[13px_1fr_auto] items-center gap-2.5">
          <i className="block h-0.5 rounded-sm" style={{ background: hue(m.model) }} />
          <span className="truncate text-meta text-dim">{m.model}</span>
          <span className="text-meta font-semibold tabular-nums text-bone">{tokens(m.tokens)}</span>
        </div>
      ))}
      <div className="mt-2 flex justify-between gap-3.5 border-t border-line pt-2">
        <span className="text-meta text-mute">Total</span>
        <span className="text-meta font-semibold tabular-nums text-text">{tokens(total)}</span>
      </div>
    </div>,
    document.body,
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
/**
 * How full a window is, for ordering.
 *
 * A blocked window with no percentage is counted as full, because it is: the
 * provider has stopped answering. Anything else without a number has none —
 * Claude Code reports no percentage at all — and sorts last either way rather
 * than being called empty, which would put "we do not know" at the top of
 * "least used".
 */
function fullness(l: Limit): number | null {
  if (l.usedPercent != null) return l.usedPercent;
  return l.status === "blocked" || l.status === "rejected" ? 100 : null;
}

function Limits({ accounts, pending }: { accounts: Account[]; pending: boolean }) {
  const [shown, setShown] = useState(10);
  const [order, setOrder] = useState<Direction>("desc");

  const rows = accounts
    .flatMap((a) => (a.limits ?? []).map((l) => ({ account: a, limit: l })))
    .sort((x, y) => {
      const a = fullness(x.limit);
      const b = fullness(y.limit);
      if (a == null && b == null) return 0;
      if (a == null) return 1;
      if (b == null) return -1;
      return order === "desc" ? b - a : a - b;
    });
  // Nothing at all is a real answer — no subscription has reported a limit —
  // and it is drawn as nothing. Not knowing yet is a different thing.
  if (!pending && !rows.length) return null;

  const page = rows.slice(0, shown);

  return (
    <section className="mt-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="mb-4 text-title font-semibold text-bone">Limits</h2>
        </div>
        {!pending && rows.length > 1 && (
          <div className="pb-4">
            <Choose
              label="Order limits by"
              value={order}
              options={[
                { value: "desc" as Direction, label: "most used" },
                { value: "asc" as Direction, label: "least used" },
              ]}
              onChange={(v) => {
                setOrder(v);
                setShown(10);
              }}
            />
          </div>
        )}
      </div>

      <div className="grid gap-x-10 gap-y-4 sm:grid-cols-2">
        {pending
          ? Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="min-w-0 max-w-[430px]" role="status" aria-label="Loading limits">
                <div className="flex items-baseline gap-2">
                  <Block className="h-3.5 w-[116px]" />
                  <Block className="h-2.5 w-[82px]" />
                  <span className="flex-1" />
                  <Block className="h-2.5 w-[64px]" />
                </div>
                {i % 2 === 1 && <Block className="mt-2 h-[3px] rounded-sm" />}
                <Block className="mt-2 h-2.5 w-[62%]" />
              </div>
            ))
          : page.map(({ account, limit }) => (
              <Gauge key={`${account.id}:${limit.scope}`} account={account} limit={limit} />
            ))}
      </div>

      {!pending && rows.length > shown && (
        <button
          type="button"
          className="mt-5 rounded-md border border-line px-3 py-1.5 text-ui text-text transition-colors duration-150 hover:border-mute/60 hover:text-bone"
          onClick={() => setShown((n) => n + 10)}
        >
          Show more
          <span className="ml-2 text-mute">{rows.length - shown} left</span>
        </button>
      )}
    </section>
  );
}

const SAGE = { text: "text-sage", bar: "var(--color-sage)" };
const AMBER = { text: "text-amber", bar: "var(--color-amber)" };
const BRICK = { text: "text-brick", bar: "var(--color-brick)" };

/**
 * What colour a window is, and why it is the percentage that decides.
 *
 * A provider says `allowed` right up until it says `blocked` — that is what the
 * word means — so colouring by status drew a bar at 94% in green and one at 79%
 * in red, which is the opposite of useful. Where there is a number, the number
 * decides, because the number is what is on screen. The word only gets a say
 * when it is the only thing we were told.
 */
function tone(l: Limit) {
  if (l.status === "blocked" || l.status === "rejected") return BRICK;
  if (l.usedPercent != null) {
    return l.usedPercent >= 90 ? BRICK : l.usedPercent >= 75 ? AMBER : SAGE;
  }
  return l.status === "allowed" ? SAGE : AMBER;
}

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
  const shade = tone(limit);
  const pct = limit.usedPercent;
  const when = resets(limit.resetsAt);

  return (
    <div className="min-w-0 max-w-[430px]">
      <div className="flex items-baseline gap-2">
        <span className="truncate text-ui text-bone">{account.name}</span>
        <span className="whitespace-nowrap text-meta text-mute">{window_(limit.scope)}</span>
        <span className="flex-1" />
        <span className={`whitespace-nowrap text-meta ${shade.text} ${pct != null ? "tabular-nums" : ""}`}>
          {pct != null ? `${pct}% used` : capitalise(limit.status)}
        </span>
      </div>

      {pct != null && (
        <div className="mt-2 h-[3px] overflow-hidden rounded-[2px]"
          style={{ background: `color-mix(in srgb, ${shade.bar} 20%, var(--color-ground))` }}>
          <div className="h-full rounded-[2px]"
            style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: shade.bar }} />
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

/* The headline taken apart.
 *
 * The sum on its own misleads, and badly: a session re-reads its cached prefix
 * on every tool call, so one that said two words can report a hundred thousand
 * tokens. The four numbers it is made of are the only way to see that — and
 * they are four different prices, which is the other reason to keep them apart.
 *
 * Numbers in full rather than abbreviated, deliberately. The headline is the one
 * that gets rounded to 17.8K; the point of these is that 2 and 11,474 are not
 * the same kind of thing, and `11.5K` beside `0` hides exactly that. */
function Composition({ t }: { t: Totals }) {
  const parts: { of: string; n: number; also?: string }[] = [
    { of: "sent", n: t.inputTokens },
    { of: "generated", n: t.outputTokens },
    { of: "read from cache", n: t.cacheReadTokens },
    {
      of: "written to cache",
      n: t.cacheWriteTokens,
      // Which kind, where the agent said: an hour costs about twice an input
      // token and five minutes about a quarter more, so it is most of what
      // decides whether the write was expensive. "All of it" rather than the
      // number again, which is the usual case and reads as a stutter.
      also:
        t.cacheWrite1hTokens === 0
          ? undefined
          : t.cacheWrite1hTokens >= t.cacheWriteTokens
            ? "all of it for an hour"
            : `${count(t.cacheWrite1hTokens)} of it for an hour`,
    },
  ];
  return (
    <dl className="mt-4 grid grid-cols-[auto_auto_auto] items-baseline gap-x-3 gap-y-2 border-t border-line pt-3.5">
      {parts.map((p) => (
        <Fragment key={p.of}>
          <dd className="justify-self-end font-narrow text-[17px] font-semibold leading-none tracking-[-0.01em] text-bone tabular-nums">
            {count(p.n)}
          </dd>
          <dt className="text-ui text-dim">
            {p.of}
            {p.also && <span className="text-mute"> — {p.also}</span>}
          </dt>
          <dd className="justify-self-end text-meta text-mute tabular-nums">
            {share(p.n, t.tokens)}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

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
  onTip,
}: {
  columns: { start: string; models: ByModel[] }[];
  bucket: string;
  hue: (m: string) => string;
  order: (list: ByModel[]) => ByModel[];
  onTip: (t: Tip | null) => void;
}) {
  // Which column the pointer is on, so the others can step back. Held here
  // rather than lifted: nothing outside the chart needs to know.
  const [over, setOver] = useState<number | null>(null);
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
  /** What the axis has no room to say: the year, and which week it is. */
  const full = (iso: string) => {
    const d = new Date(iso);
    if (bucket === "month") return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    if (bucket === "week") return `Week of ${label(iso)}`;
    return label(iso);
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
        const show = (e: { clientX: number; clientY: number }) => {
          setOver(i);
          onTip({ x: e.clientX, y: e.clientY, head: full(column.start), models: column.models });
        };
        const away = () => {
          setOver((at) => (at === i ? null : at));
          onTip(null);
        };
        return (
          <g
            key={column.start}
            // The one being read keeps its colour and the rest step back, so a
            // stack of four hues in the middle of a year is findable at all.
            // Opacity rather than a highlight: dimming the others changes
            // nothing about the one you are looking at, which is the point.
            opacity={over === null || over === i ? 1 : 0.35}
            style={{ transition: "opacity 120ms var(--ease-swift)" }}
          >
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
            {/* Its own label comes with it, including the ones the axis is too
                crowded to print — on a year of months that is how you know
                which column you are on. */}
            {(!sparse || i % 2 === 1 || over === i) && (
              <text
                x={x + bar / 2}
                y={BOTTOM + 19}
                textAnchor="middle"
                className={`text-[11px] tabular-nums ${over === i ? "fill-text" : "fill-mute"}`}
              >
                {label(column.start)}
              </text>
            )}
            {/* The whole band, not the painted pixels: a 5px bar on a year of
                months is a target nobody hits. Keyboard gets the same. */}
            <rect
              x={i * band}
              y={TOP}
              width={band}
              height={BOTTOM - TOP}
              fill="transparent"
              tabIndex={0}
              role="img"
              aria-label={`${full(column.start)}: ${tokens(totals[i])} billed tokens`}
              onPointerMove={show}
              onPointerEnter={show}
              onPointerLeave={away}
              onFocus={(e) => {
                const box = e.currentTarget.getBoundingClientRect();
                setOver(i);
                onTip({
                  x: box.left + box.width / 2,
                  y: box.top + box.height,
                  head: full(column.start),
                  models: column.models,
                });
              }}
              onBlur={away}
            />
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
      return plural(g.turns, "turn");
    default:
      return `${plural(g.tasks, "task")}, ${plural(g.people, "person", "people")}`;
  }
}

function Ledger({
  groups,
  rest,
  total,
  periodTokens,
  by,
  nested,
  open,
  onOpen,
  hue,
  order,
  onTip,
}: {
  groups: Group[];
  rest?: Group;
  total: number;
  periodTokens: number;
  by: GroupKey;
  nested: boolean;
  open: string | null;
  onOpen: (k: string | null) => void;
  hue: (m: string) => string;
  order: (list: ByModel[]) => ByModel[];
  onTip: (t: Tip | null) => void;
}) {
  if (!groups.length)
    return (
      <p className="py-5 text-ui text-mute">
        Nothing ran in this period. Widen the range, or change the scope.
      </p>
    );

  // The scale is the largest row on screen. The remainder is not a row — it is
  // what is not on screen — so it neither draws a bar nor sets the scale.
  const max = Math.max(...groups.map((g) => g.tokens), 1);

  return (
    <div>
      {groups.map((g) => {
        const id = g.key ?? "∅";
        return (
          <div key={id}>
            <Line g={g} by={by} scale={max} hue={hue} order={order} onTip={onTip} openable={nested}
              expanded={open === id} onToggle={() => onOpen(open === id ? null : id)} />
            {nested && open === id && !!g.children?.length && (
              <div className="bg-panel">
                {g.children.slice(0, 6).map((c) => (
                  <Line key={c.key ?? "∅"} g={c} by={by} nested order={order} onTip={onTip}
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
      {/* Not "smaller": once the order can be reversed, or by name, or by
          date, what is left over is only what is left over. */}
      {rest && (
        <div className="grid grid-cols-[minmax(0,1fr)_150px_78px_90px] items-center gap-5 border-b border-line-soft py-3">
          <div className="min-w-0">
            <div className="truncate text-body text-dim">
              {plural(total - groups.length, `more ${GROUPS[by]}`)}
            </div>
            <div className="mt-0.5 text-meta text-mute">
              {periodTokens > 0
                ? `${Math.round((rest.tokens / periodTokens) * 100)}% of the period`
                : "not shown"}
            </div>
          </div>
          <div />
          <div className="text-right font-narrow text-[15px] font-medium tabular-nums text-text">
            {tokens(rest.tokens)}
          </div>
          <Cost g={rest} />
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
  onTip,
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
  onTip: (t: Tip | null) => void;
  nested?: boolean;
  openable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  // Children scale against their siblings but never reach the parent's length:
  // a child as long as its parent reads as equal to it.
  const span = nested ? 68 : 100;
  const width = Math.min(span, Math.max(4, (g.tokens / scale) * span));
  const head = g.name ?? unnamed(g, by);
  const show = (e: { clientX: number; clientY: number }) =>
    onTip({ x: e.clientX, y: e.clientY, head, models: g.models });

  return (
    <div
      className={`grid grid-cols-[minmax(0,1fr)_150px_78px_90px] items-center gap-5 border-b py-3 ${
        nested ? "border-transparent pl-4" : "border-line-soft"
      } ${openable ? "cursor-pointer" : ""}`}
      onPointerMove={show}
      onPointerLeave={() => onTip(null)}
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
  if (by === "subscription") return "No subscription";
  return g.key ?? "Unknown";
}

/* ── controls ─────────────────────────────────────────────────────────── */

/**
 * Who to narrow to.
 *
 * A search rather than a list, because a row of names stops working at the
 * second team and this installation may have two hundred people in it. The
 * ranked ledger below is still the way most people find somebody — this is the
 * escape hatch for when you already know who you want.
 */
function ScopePicker({
  at,
  colleagues,
  teams,
  onPick,
  onClose,
}: {
  at: { left: number; top: number; flip: boolean };
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

  return createPortal(
    <>
      <div className="fixed inset-0 z-[60]" onClick={onClose} aria-hidden />
      <div
        style={{
          left: Math.min(at.left - 11, Math.max(8, window.innerWidth - 298)),
          ...(at.flip ? { bottom: window.innerHeight - at.top + 13 } : { top: at.top + 5 }),
        }}
        className="fixed z-[61] w-[290px] rounded-md bg-overlay p-[7px] shadow-float"
      >
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
        {/* `overscroll-contain`: without it, reaching either end of this list
            hands the wheel to the page behind, which then scrolls the trigger
            — and the panel with it — off the screen. */}
        <div className="max-h-[286px] overflow-y-auto overscroll-contain" role="listbox">
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
    </>,
    document.body,
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
