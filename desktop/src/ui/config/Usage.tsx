/**
 * What the agents spent, and on what.
 *
 * The pane answers two questions that are not the same: "what did this feature
 * cost me", which is a developer's and is grouped by task, and "where is the
 * money going", which is an administrator's and is grouped by person or
 * directory. One ledger, cut either way — so the grouping controls sit on the
 * ledger rather than at the top of the pane, because they change that and
 * nothing above it.
 *
 * **Access is not a mode, and there is no gate.** Consumption has no role
 * check on the server: every read underneath is narrowed by `filed_within`,
 * the same predicate as workspaces and secrets, and an administrator gets no
 * bypass. So there is one pane, every member may open it, and what differs
 * between an owner and a member is which rows come back. Nothing here is
 * hidden by role, and nothing draws `denied` — see `troubleFor` below.
 *
 * ## Colour, which is why this screen was the last one to move
 *
 * **Colour means the model, and only inside one frame.** The four series hues
 * are a sanctioned namespace now, contained by four rules — one frame;
 * category never state; below ember, measured; flat, still, unfilled — and
 * this file keeps the first of them. The web stacks the same hues on the meter
 * of every one of twenty-five ledger rows, in a key floating above them, and
 * in the tooltip; here they are inside the chart's plotted frame, the key
 * directly under it, and the layer that reads either. The ledger's meter is
 * one neutral length.
 *
 * The split is not lost. It is on a row's own hover — `usage-tip`, which is a
 * frame — and under *then by model*, which is a first-class control. The rule
 * and the hue function are in `config/usage-rules.ts`; `usage-colour.test.tsx`
 * reads it back off the rendered markup, because a rule nothing is asserted to
 * consult is a rule that governs nothing.
 *
 * ## Limits goes last
 *
 * It is the only section on the pane that **ignores the scope and the
 * period** — a limit is the provider's accounting on the provider's clock and
 * there is no such thing as last month's limit — and a section that does not
 * answer the controls must not sit between two that do. Wedged in the middle,
 * as the web has it, the first thing it teaches a weekly reader is that
 * changing the period sometimes does nothing, which is a lie about the
 * controls rather than a fact about quotas.
 *
 * The counterargument — a subscription at 91% is more urgent than which task
 * cost most — was weighed and rejected: urgency on this product has exactly
 * one carrier and it is ember, which this screen may not use. Moving Limits up
 * to shout would be using position to do ember's job.
 */
import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { keepPreviousData } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  ChartNoAxesColumn,
  ChevronDown,
  ChevronRight,
  CircleSlash2,
  RefreshCw,
  Search,
  TriangleAlert,
} from "lucide-react";
import { Choose, Icon, Segmented } from "~/components/ui";
import { Pop } from "~/ui/Pop";
import { Blank, Note, Typed, WhereTo } from "~/ui/config/bits";
import { useConsumption } from "~/api/generated/consumption/consumption";
import { useListAccounts } from "~/api/generated/accounts/accounts";
import { useListColleagues, useListTeams } from "~/api/generated/access/access";
import type { Account, ByModel, Column, Group, Limit, Totals } from "~/api/generated/model";
import { AGENT_SHORT, AGENT_LABEL } from "~/components/AgentMark";
import { trouble as troubleOf, useDirectories, why } from "~/data";
import type { Trouble } from "~/data";
import {
  GROUPS,
  GROUPS_MANY,
  METER_FILL,
  RANGES,
  SEARCHABLE,
  SORTS,
  columnFull,
  columnLabel,
  ceiling,
  consumptionAsk,
  count,
  detail,
  folder,
  fuller,
  dayKey,
  liveModels,
  maySwap,
  meterWidth,
  modelsByWeight,
  peak,
  perConversation,
  plural,
  readState,
  rowKey,
  scopeIsFixed,
  scopeMatches,
  scopeName,
  seriesIn,
  share,
  sortSay,
  thenOptions,
  tokensText,
  tone,
  unnamed,
  usedSaid,
  whenSaid,
  windowSaid,
  type Bucket,
  type GroupKey,
  type RangeKey,
  type Scope,
  type SortKey,
} from "~/ui/config/usage-rules";

/** The smallest radius in the scale, `--radius-xs`, as a number SVG can take. */
const CAP = 4;

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
    // The first value is already settled; waiting on it would delay the pane.
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/**
 * Re-renders when the reader's day turns over.
 *
 * The period is *their* fortnight, so it has to move when their midnight
 * passes. Two triggers, because the common case is not a tick: a minute timer
 * for a window somebody is watching, and `visibilitychange` for the much more
 * likely one — a laptop that slept through the boundary and is opened again,
 * where no timer fired at all.
 *
 * State changes only when the day key actually changes, so the minute tick
 * costs one comparison and nothing else.
 */
function useToday(): string {
  const [day, setDay] = useState(() => dayKey(new Date()));
  useEffect(() => {
    const check = () => setDay((was) => {
      const now = dayKey(new Date());
      return now === was ? was : now;
    });
    const every = setInterval(check, 60_000);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      clearInterval(every);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, []);
  return day;
}

export function Usage() {
  const [range, setRange] = useState<RangeKey>("d14");
  const [group, setGroup] = useState<GroupKey>("task");
  const [then, setThen] = useState<GroupKey | "">("");
  const [scope, setScope] = useState<Scope>({ kind: "all" });
  const [picking, setPicking] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  /* Created once, and never a dependency: the setter it hands out is stable
     for the life of the pane. */
  const [tips] = useState(makeTipStore);
  const [sort, setSort] = useState<SortKey>("tokens:desc");
  // What is typed, and what has been asked for. Two states because they are
  // two things: the field has to answer every keystroke, and the server does
  // not — a request per character is a dozen queries to answer one question.
  const [typed, setTyped] = useState("");
  const find = useDebounced(typed, 300);
  const [limit, setLimit] = useState(25);

  const colleagues = useListColleagues();
  const teams = useListTeams();
  const directories = useDirectories();
  const accounts = useListAccounts();

  /* The whole request, from one rule. `periodOf` rounds to the day inside it,
     so the key is stable across renders — otherwise every tick of the clock
     is a new request for the same answer.

     **`today` is in the dependencies because the period is the reader's.**
     Keyed on the controls alone, a window left open overnight kept
     yesterday's fortnight until something unrelated re-rendered it, and then
     jumped — which reads as the sort having changed the data. */
  const today = useToday();
  const ask = useMemo(
    () => consumptionAsk({ range, group, then, scope, sort, find, limit, now: new Date() }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `today` is the clock, read inside.
    [range, group, then, scope, sort, find, limit, today],
  );

  const { data, isPending, isFetching, isError, error, refetch } = useConsumption(
    ask,
    {
      // Changing the period, the sort or the grouping is a new query key, which
      // would otherwise empty the pane and show skeletons again on every click.
      // Holding the last answer means the only blank state anybody sees is the
      // first one — after that the pane dims and swaps, and never jumps.
      query: { placeholderData: keepPreviousData },
    },
  );

  // One hue per model, assigned by how much it did over the whole period, so a
  // filter that drops a model never repaints the ones that are left.
  const models = useMemo(() => modelsByWeight(data?.series ?? []), [data]);

  /* ── which of the states the pane is in ──────────────────────────────
     Nothing below may draw a chart with no data in it. An axis labelled "1"
     with no columns is what a failure looked like, and it reads as a product
     that is broken rather than one that is waiting or empty. */
  const scopeKey = `${scope.kind}:${"id" in scope ? scope.id : ""}`;
  const wants = `${range}|${scopeKey}`;
  // Adjusted during render rather than in an effect, which is what React asks
  // for when state is derived from what just arrived: an effect would paint
  // the stale frame first and correct it, and a ref would be read during a
  // render that may never commit.
  const [showing, setShowing] = useState("");
  if (data && !isFetching && showing !== wants) setShowing(wants);

  // The chart and the figures depend on the period and the scope, and on
  // nothing else — so a new sort keeps them, and a new period replaces them.
  // Holding the old ones would be worse than a skeleton: the control above
  // already says the new period, and a chart of the old one under it is a lie
  // rather than a stale answer.
  const state = readState({
    pending: isPending,
    fetching: isFetching,
    has: !!data,
    showing,
    wants,
  });
  const bad: Trouble | null = isError ? troubleOf(error) : null;
  const dark = bad === "dark";
  /**
   * **There are two bad branches here, and `denied` is not one of them.**
   *
   * `bits.tsx` draws five states and this pane draws four. A 403 from
   * `/consumption` is a **bug**, not an access rule: the handler has no role
   * check, and the specification says an empty or forbidden destination "is a
   * defect, not an access rule". So a refusal falls in with the failures —
   * retryable, and saying nothing untrue — rather than getting a lock that
   * tells a member something false about their own access.
   *
   * Written as the absence of a branch rather than as a mapping from `denied`
   * to `error`, because a mapping nothing downstream can tell apart is a rule
   * that governs nothing. What keeps this honest is `usage.test.tsx` rendering
   * a 403 and asserting there is no lock on the screen.
   */
  const failed = !!bad && !dark;
  const totals = data?.totals;
  /* **`find` narrows the ledger and nothing else.** The server binds it into
     the groups query only — `consumption_where()` carries the period and the
     scope, and the search clause is added by `consumption_groups` alone — so
     the reading is of the period whatever is typed. That is what makes "the
     reading stays" possible for a search that matches nothing, and it is why
     *empty* and *nothing matches* are two states here and were one on the web. */
  const nothingRan = !!totals && totals.rows === 0;
  const searched = find.trim();
  const groups = data?.groups ?? [];
  const noMatch = !nothingRan && !!searched && groups.length === 0 && state !== "settling";

  // Any change to what is being listed starts again at the top. Keeping the
  // page number across a new sort shows somebody rows 26–50 of a list they
  // have not seen the beginning of.
  const reset = () => setLimit(25);
  const fixed = !directories.loading && scopeIsFixed(directories.data);

  return (
    <div className="pg" data-testid="usage-pane">
      <div className="pg-head">
        <div>
          <h1 data-testid="usage-title">Usage</h1>
          <p className="sub" data-testid="usage-sub">
            What the agents spent, and on what.
          </p>
        </div>
      </div>

      {/* Above everything the body swaps, and the body stays: rows from a
          server that is not answering do not disappear. */}
      {dark && (
        <WhereTo testId="usage-dark" icon={<Icon of={CircleSlash2} size={16} />}>
          <b>Can’t reach this Firetower.</b> Showing what was last known. Rows from a server that
          is not answering stay visible.
        </WhereTo>
      )}

      {/* A refusal replaces the body and the controls go with it: narrowing a
          list nobody can read is not a thing to offer. `bits.tsx`' own rule. */}
      {!failed && (
        <div className="filterline">
          {fixed ? (
            /* **Plain text, not a greyed button.** There is nothing else for it
               to reach, and a disabled control is how an interface says you are
               being withheld from. The id covers both lines, so the assertion
               that there is no `button` and no `disabled` under it has something
               to bite on. */
            <div className="flex flex-col gap-[3px]" data-testid="usage-scope-fixed">
              <span className="text-ui text-bone">Just your own work</span>
              <span className="max-w-[48ch] text-meta text-mute">
                You have not been granted anything beyond your own root, so there is nothing else
                to show.
              </span>
            </div>
          ) : (
            <>
              <button
                type="button"
                className="btn plain"
                data-testid="usage-scope"
                aria-haspopup="menu"
                aria-expanded={!!picking}
                onClick={(e) => setPicking(picking ? null : e.currentTarget)}
              >
                <span className="min-w-0 truncate">{scopeName(scope)}</span>
                <span className="cv">
                  <Icon of={ChevronDown} size={14} />
                </span>
              </button>
              {picking && (
                <ScopePicker
                  anchor={picking}
                  teams={teams.data ?? []}
                  colleagues={colleagues.data ?? []}
                  onClose={() => setPicking(null)}
                  onPick={(s) => {
                    setScope(s);
                    setPicking(null);
                    if (s.kind !== "all" && group === "person") setGroup("task");
                    reset();
                  }}
                />
              )}
            </>
          )}
          <span className="right">
            <Segmented
              testId="usage-period"
              label="Over what period"
              value={range}
              options={(Object.keys(RANGES) as RangeKey[]).map((k) => [k, RANGES[k].label] as const)}
              onChange={(k) => {
                setRange(k);
                setOpen(null);
                reset();
              }}
            />
          </span>
        </div>
      )}

      {/* `.stale2` for a dark server, `.dimmed` for a read that is only
          refetching: the sort and the grouping do not move the chart or the
          figures, so nothing is replaced and nothing jumps. */}
      <div className={dark ? "stale2" : state === "refetching" ? "dimmed" : ""}>
        {failed ? (
          <Blank
            icon={TriangleAlert}
            title="That did not load"
            shape="plate"
            testId="usage-error"
            action={
              <button type="button" className="btn plain" data-testid="usage-retry" onClick={() => void refetch()}>
                <Icon of={RefreshCw} size={14} />
                Try again
              </button>
            }
          >
            A long period over a lot of history can take longer than the connection will wait. Try
            again, or narrow the period above.
          </Blank>
        ) : (
          <>
            <Reading
              settling={state === "settling" || state === "stale"}
              empty={nothingRan}
              totals={totals}
              series={data?.series ?? []}
              models={models}
              bucket={RANGES[range].bucket}
              onTip={tips.set}
            />

            {/* Said once: the reading's blank already says nothing ran. */}
            {!nothingRan && (
              /* The ledger keeps the previous rows while the reading is
                 replaced, because the rows are still of the period they were
                 read for until the new ones land. */
              <div className={state === "stale" ? "dimmed" : undefined}>
                <Ledger
                  settling={state === "settling"}
                  groups={groups}
                  rest={data?.rest ?? undefined}
                  total={data?.groupCount ?? 0}
                  periodTokens={totals?.tokens ?? 0}
                  by={group}
                  then={then}
                  sort={sort}
                  typed={typed}
                  noMatch={noMatch}
                  searched={searched}
                  open={open}
                  limit={limit}
                  onTip={tips.set}
                  onOpen={setOpen}
                  onTyped={(v) => {
                    setTyped(v);
                    reset();
                  }}
                  onGroup={(v) => {
                    /* **No second level to clear.** The grouping menu does
                       not offer the level that is already the second one, and
                       the only other way the pair moves is the swap, which
                       `maySwap` keeps to pairs this menu would build.

                       What was typed goes only where the next grouping has no
                       field to show it in — a filter nobody can see or clear
                       is worse than losing a word, and between two groupings
                       that both offer one it is usually the same word being
                       hunted. The *request* needs no such care: the search
                       goes nowhere a search is not offered, whatever the
                       debounced copy is still holding. */
                    setGroup(v);
                    if (!SEARCHABLE.includes(v)) setTyped("");
                    setOpen(null);
                    reset();
                  }}
                  onThen={(v) => {
                    setThen(v);
                    setOpen(null);
                  }}
                  onSwap={() => {
                    if (!then || !maySwap(group, then)) return;
                    const outer = group;
                    setGroup(then);
                    setThen(outer);
                    setOpen(null);
                  }}
                  onSort={(v) => {
                    setSort(v);
                    setOpen(null);
                    reset();
                  }}
                  onMore={() => setLimit((n) => n + 25)}
                />
              </div>
            )}

            {/* Last, and on nobody's period but the provider's. */}
            {/* The read is handed over whole, rather than as rows and a
                boolean, because this section has to tell *nothing reported a
                ceiling* from *we could not ask* — see `Limits`. */}
            {state !== "settling" && (
              <Limits
                feed={{
                  data: accounts.data ?? [],
                  loading: accounts.isPending,
                  error: accounts.isError ? why(accounts.error) : null,
                  onRetry: () => void accounts.refetch(),
                }}
              />
            )}
          </>
        )}
      </div>

      <TipLayer store={tips} models={models} />
    </div>
  );
}

/* ── the reading ─────────────────────────────────────────────────────── */

function Reading({
  settling,
  empty,
  totals,
  series,
  models,
  bucket,
  onTip,
}: {
  settling: boolean;
  empty: boolean;
  totals?: Totals;
  series: Column[];
  models: string[];
  bucket: Bucket;
  onTip: (t: Tip | null) => void;
}) {
  if (settling) return <ReadingSkeleton />;
  if (empty)
    return (
      <Blank icon={ChartNoAxesColumn} title="Nothing ran in this period." testId="usage-empty">
        Widen the range above, or change who it covers.
      </Blank>
    );

  /* The key's denominator is **the chart's own sum**, not the headline's.
     They are the same four token columns on the server, so on a real answer
     they agree — but the shares under a chart have to add up to the chart,
     and against any other number a reader who adds them is told the chart is
     wrong. */
  const per = new Map<string, number>();
  let total = 0;
  for (const column of series)
    for (const m of column.models) {
      per.set(m.model, (per.get(m.model) ?? 0) + m.tokens);
      total += m.tokens;
    }

  return (
    <section className="reading">
      <Headline totals={totals} />
      <div className="chartwrap">
        <Trace columns={series} models={models} bucket={bucket} onTip={onTip} />
      </div>
      <Key models={models} per={per} total={total} />

      {/* The shape of the work, now that the tokens are all in the headline.
          Turns is not a column of its own — it is the unit everything else is
          counted in, so it reads better as how many a conversation took than
          as a number beside them. */}
      <div className="figures">
        <Figure
          id="workspaces"
          label="Workspaces"
          value={totals ? count(totals.workspaces) : "—"}
          note={
            totals && totals.workspaces !== totals.conversations
              ? `Holding ${plural(totals.conversations, "conversation")}.`
              : "One conversation each."
          }
        />
        <Figure
          id="tasks"
          label="Tasks"
          value={totals ? count(totals.tasks) : "—"}
          note={
            totals && totals.tasks === 0
              ? "Nothing here was started from a tracker."
              : "Worked on in this period."
          }
        />
        <Figure
          id="conversations"
          label="Conversations"
          value={totals ? count(totals.conversations) : "—"}
          note={totals ? perConversation(totals) : ""}
        />
        <Figure
          id="people"
          label="People"
          value={totals ? count(totals.people) : "—"}
          note={totals ? "Ran an agent in this period." : ""}
        />
      </div>

      {/* Said once, plainly, rather than left for somebody to notice the
          numbers are short. These turns ran and are counted as turns; what
          they spent is the thing nobody told us.

          **No agent is named.** Which of them report is a moving fact — the
          hooks that would carry Cursor's tokens are a gap its own team has
          said it means to close — and a sentence that names one goes stale
          facing the person it misleads. */}
      {totals && totals.unreportedTurns > 0 && (
        <p className="unreported" data-testid="usage-unreported">
          <b>
            {plural(totals.unreportedTurns, "turn")} above{" "}
            {totals.unreportedTurns === 1 ? "has" : "have"} no tokens counted.
          </b>{" "}
          Their agent reported none, so they are in the turn count and not in the totals.
        </p>
      )}
    </section>
  );
}

/**
 * The total, with what it is made of behind a hover.
 *
 * The number on its own misleads: a session re-reads its cached prefix on
 * every tool call, so one that said two words reports tens of thousands of
 * tokens. The breakdown is the correction, and it is held back rather than
 * printed because the headline is the headline.
 *
 * Held back is not hidden. It opens on focus as well as hover, so a keyboard
 * reaches it, and the dashed rule under the label is there to say something is
 * behind it — a number that rewards hovering with no sign that it does is a
 * secret. Escape closes it, and so does anything that moves the page.
 *
 * `--text-hero` and left, rather than the web's 64px `--text-figure` against
 * the right edge: 40px is the desk's own "the one thing on this screen" size,
 * and 64px over a 32px `.pg-head h1` makes the pane's title the subtitle.
 */
function Headline({ totals }: { totals?: Totals }) {
  const [at, setAt] = useState<DOMRect | null>(null);
  const el = useRef<HTMLDivElement>(null);
  const has = !!totals && totals.tokens > 0;

  const show = () => {
    if (has) setAt(el.current?.getBoundingClientRect() ?? null);
  };
  const hide = () => setAt(null);

  useEffect(() => {
    if (!at) return;
    const off = () => setAt(null);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setAt(null);
    window.addEventListener("scroll", off, true);
    window.addEventListener("resize", off);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("scroll", off, true);
      window.removeEventListener("resize", off);
      window.removeEventListener("keydown", esc);
    };
  }, [at]);

  return (
    <div
      ref={el}
      tabIndex={has ? 0 : undefined}
      className="headline"
      onPointerEnter={show}
      onPointerLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <div className="fig" data-testid="usage-total">
        {totals ? tokensText(totals.tokens) : "—"}
      </div>
      <div className="cap" data-testid="usage-total-caption">
        {/* Dashed only where there is something behind it. */}
        {has ? <span>tokens processed</span> : "tokens processed"}
      </div>
      {has && at && totals && <Composition totals={totals} at={at} />}
    </div>
  );
}

/**
 * The four numbers the headline is the sum of.
 *
 * Four rather than three because they are four different prices: an output
 * token costs several times an input one, a cache read about a tenth, and a
 * one-hour write about twice. Lumping any of them together would hide the part
 * that decides the bill.
 *
 * Figures in full rather than abbreviated. The headline is the one that gets
 * rounded to 35.6K; the point of these is that 4 and 29,176 are not the same
 * kind of thing, which `29.2K` beside `4` hides exactly.
 */
function Composition({ totals, at }: { totals: Totals; at: DOMRect }) {
  const parts: { of: string; n: number; also?: string }[] = [
    { of: "sent", n: totals.inputTokens },
    { of: "generated", n: totals.outputTokens },
    { of: "read from cache", n: totals.cacheReadTokens },
    {
      of: "written to cache",
      n: totals.cacheWriteTokens,
      // Which kind, where the agent said: an hour costs about twice an input
      // token and five minutes about a quarter more, so it is most of what
      // decides whether the write was expensive. "All of it" rather than the
      // number again, which is the usual case and reads as a stutter.
      also:
        totals.cacheWrite1hTokens === 0
          ? undefined
          : totals.cacheWrite1hTokens >= totals.cacheWriteTokens
            ? "all of it for an hour"
            : `${count(totals.cacheWrite1hTokens)} of it for an hour`,
    },
  ];
  if (typeof document === "undefined") return null;

  // On `body` and `fixed`, for the reason `Pop` gives: anchored from inside a
  // scrolling sheet it would otherwise be drawn in the wrong place the moment
  // anything above it moved.
  return createPortal(
    <div
      className="comp"
      role="tooltip"
      data-testid="usage-total-breakdown"
      style={{ left: Math.min(at.left, window.innerWidth - 330), top: at.bottom + 10 }}
    >
      <dl>
        {parts.map((p) => (
          <Fragment key={p.of}>
            <dd className="num">{count(p.n)}</dd>
            <dt>
              {p.of}
              {p.also && <span className="also"> — {p.also}</span>}
            </dt>
            <dd className="pc">{share(p.n, totals.tokens)}</dd>
          </Fragment>
        ))}
      </dl>
    </div>,
    document.body,
  );
}

function Figure({ id, label, value, note }: { id: string; label: string; value: string; note: string }) {
  return (
    <div className="f" data-testid={`usage-figure-${id}`}>
      <div className="k">{label}</div>
      <div className="v">{value}</div>
      <div className="n">{note}</div>
    </div>
  );
}

/**
 * The key — **directly under the chart**, which is half of the containment
 * rule.
 *
 * The web floats it above the ledger, where it is a mapping a reader has to
 * carry further than a glance: at that distance it has stopped being the
 * chart's and become the page's. A legend belongs beside what it reads.
 *
 * It draws nothing under two models, because one hue mapping one name is not a
 * key, and it carries each model's share — which the web's did not and which
 * is most of what somebody wants off it.
 */
function Key({ models, per, total }: { models: string[]; per: Map<string, number>; total: number }) {
  if (models.length < 2) return null;
  const key = seriesIn("usage-key", models);
  const shown = models.slice(0, 4);
  const folded = models.slice(4);

  return (
    <div className="key" data-testid={key.testId}>
      {shown.map((m) => (
        <span key={m} className="it" data-testid={`usage-key-${m}`}>
          <i style={{ background: key.hue(m) }} />
          {m}
          <span className="pc">{share(per.get(m) ?? 0, total)}</span>
        </span>
      ))}
      {folded.length > 0 && (
        <span className="it" data-testid="usage-key-folded">
          {/* The fold takes `--color-mute`, which is the ground ramp rather
              than a fifth hue: a fold is a shape decision. */}
          <i style={{ background: key.hue(folded[0]) }} />
          {plural(folded.length, "more model")}
          <span className="pc">
            {share(
              folded.reduce((a, m) => a + (per.get(m) ?? 0), 0),
              total,
            )}
          </span>
        </span>
      )}
    </div>
  );
}

function Trace({
  columns,
  models,
  bucket,
  onTip,
}: {
  columns: Column[];
  models: string[];
  bucket: Bucket;
  onTip: (t: Tip | null) => void;
}) {
  // Which column the pointer is on, so the others can step back. Held here
  // rather than lifted: nothing outside the chart needs to know.
  const [over, setOver] = useState<number | null>(null);
  const chart = seriesIn("usage-chart", models);
  const W = 1004;
  const TOP = 10;
  const BOTTOM = 196;
  const totals = columns.map((c) => c.models.reduce((a, m) => a + m.tokens, 0));
  const max = ceiling(Math.max(1, ...totals));
  const band = columns.length ? W / columns.length : W;
  const bar = Math.min(26, Math.max(5, band * 0.42));
  const y = (v: number) => BOTTOM - (v / max) * (BOTTOM - TOP);
  const sparse = columns.length > 16;

  return (
    <svg
      viewBox={`0 0 ${W} 232`}
      className="chart"
      role="img"
      data-testid={chart.testId}
      aria-label={`Billed tokens per ${bucket}, split by model.`}
    >
      {[0.5, 1].map((f) => {
        const at = Math.round(y(max * f)) + 0.5;
        return (
          <g key={f}>
            {/* **`--color-line-soft`, not `--color-grid`.** `--color-grid` has
                exactly one consumer in the repository — this line — and no
                definition anywhere, so every gridline in production was the
                hard-coded `#1c1c20` fallback beside it. Dormant on the web,
                which never sets `data-theme` and so sits permanently on the
                dark branch two points off this token; live here, where
                `theme.ts` resolves the theme and takes light, and a near-black
                hairline on a white sheet is the bug becoming visible. */}
            <line
              x1={0}
              x2={W}
              y1={at}
              y2={at}
              stroke="var(--color-line-soft)"
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
            <text x={0} y={at - 6} className="axis">
              {tokensText(max * f)}
            </text>
          </g>
        );
      })}
      <line
        x1={0}
        x2={W}
        y1={Math.round(y(0)) + 0.5}
        y2={Math.round(y(0)) + 0.5}
        stroke="var(--color-line)"
        strokeWidth={1}
        shapeRendering="crispEdges"
      />

      {columns.map((column, i) => {
        const x = i * band + (band - bar) / 2;
        const live = liveModels(column.models, models);
        let cursor = y(0);
        const show = (e: { clientX: number; clientY: number }) => {
          setOver(i);
          onTip({
            x: e.clientX,
            y: e.clientY,
            from: "chart",
            head: columnFull(column.start, bucket),
            models: column.models,
          });
        };
        const away = () => {
          setOver((at) => (at === i ? null : at));
          onTip(null);
        };
        return (
          <g
            key={column.start}
            className="col"
            // The one being read keeps its colour and the rest step back, so a
            // stack of four hues in the middle of a year is findable at all.
            // Opacity rather than a highlight: dimming the others changes
            // nothing about the one you are looking at, which is the point.
            opacity={over === null || over === i ? 1 : 0.35}
          >
            {live.map((m, n) => {
              const h = (m.tokens / max) * (BOTTOM - TOP);
              const top = cursor - h;
              cursor = top;
              const last = n === live.length - 1;
              // The 2px gap separates; it does not tax. A segment smaller than
              // the gap keeps its height, or a quiet day renders as stripes.
              const drawn = last ? h : h > 4 ? h - 2 : h;
              // `--radius-xs`, not the web's 3 — three is not in the scale and
              // 4 reads the same on a 26px column.
              const r = last ? Math.min(CAP, h / 2, bar / 2) : 0;
              return (
                <rect
                  key={m.model}
                  x={x}
                  y={top}
                  width={bar}
                  height={Math.max(1, drawn)}
                  rx={r}
                  ry={r}
                  fill={chart.hue(m.model)}
                />
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
                className={over === i ? "axis on" : "axis"}
              >
                {columnLabel(column.start, bucket)}
              </text>
            )}
            {/* The whole band, not the painted pixels: a 5px bar on a year of
                months is a target nobody hits. Keyboard gets the same. */}
            <rect
              className="hit"
              x={i * band}
              y={TOP}
              width={band}
              height={BOTTOM - TOP}
              tabIndex={0}
              role="img"
              data-testid={`usage-chart-column-${column.start.slice(0, 10)}`}
              aria-label={`${columnFull(column.start, bucket)}: ${tokensText(totals[i])} billed tokens`}
              onPointerMove={show}
              onPointerEnter={show}
              onPointerLeave={away}
              onFocus={(e) => {
                const box = e.currentTarget.getBoundingClientRect();
                setOver(i);
                onTip({
                  x: box.left + box.width / 2,
                  y: box.top + box.height,
                  from: "chart",
                  head: columnFull(column.start, bucket),
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

/* ── waiting ─────────────────────────────────────────────────────────── */

/**
 * What the pane looks like before it has an answer.
 *
 * The shapes are the real ones: the figure sits where the figure sits, the
 * columns stand on the baseline, the rows are the row grid. A skeleton whose
 * geometry does not match what replaces it is a layout jump with extra steps,
 * and the jump is the thing it was supposed to prevent.
 *
 * **No axis, no gridline and no zero**, which is the rule the whole file is
 * built around: nothing may draw a chart with no data in it.
 *
 * Column heights are fixed rather than random, so a re-render does not make
 * the placeholder dance while somebody waits.
 */
const BARS = [34, 52, 41, 68, 57, 79, 62, 88, 71, 96, 83, 100];

function ReadingSkeleton() {
  return (
    <div className="reading" role="status" aria-label="Loading usage" data-testid="usage-settling">
      <div>
        <span className="settling h-10 w-[170px] rounded-md" />
        <span className="settling mt-2 block h-2.5 w-[92px]" />
      </div>
      <div className="mt-5 flex h-[196px] items-end gap-[1.6%] border-b border-line">
        {BARS.map((h, i) => (
          <span key={i} className="settling flex-1 rounded-t" style={{ height: `${h}%` }} />
        ))}
      </div>
      <div className="mt-2.5 flex gap-[1.6%]">
        {BARS.map((_, i) => (
          <span key={i} className="flex flex-1 justify-center">
            <span className="settling h-2 w-[68%]" />
          </span>
        ))}
      </div>
      <div className="figures">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="f">
            <span className="settling h-2.5 w-[86px]" />
            <span className="settling mt-2 block h-[22px] w-[112px] rounded-md" />
            <span className="settling mt-2 block h-2 w-[80%]" />
          </div>
        ))}
      </div>
    </div>
  );
}

function LedgerSkeleton() {
  return (
    <div className="lrows" role="status" aria-label="Loading the ledger" data-testid="usage-settling-ledger">
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <div key={i} className="r">
          <span className="tx">
            {/* Varied widths, because eight identical bars read as a table of
                one repeated thing rather than a list of different ones. */}
            <span className="settling h-2.5" style={{ width: `${34 + ((i * 13) % 42)}%` }} />
            <span className="settling mt-1.5 block h-2" style={{ width: `${22 + ((i * 7) % 20)}%` }} />
          </span>
          <span className="lmeter">
            <span className="settling h-[7px] rounded-sm" style={{ width: `${100 - i * 9}%` }} />
          </span>
          <span className="amt">
            <span className="settling ml-auto h-2.5 w-[48px]" />
          </span>
        </div>
      ))}
    </div>
  );
}

/* ── the ledger ──────────────────────────────────────────────────────── */

/**
 * Where it went, cut whichever way the controls say.
 *
 * **Nothing in this subtree is handed the page's model order**, which is the
 * containment change made structural rather than remembered: there is no hue
 * function in scope here, so a row cannot paint one even by accident. The
 * split a row still opens is `usage-tip`'s, drawn by the layer above.
 *
 * Exported so the states that are reached by *pressing something* — a second
 * level, an open row, a search that matched nothing — can be drawn in a test
 * that has no browser to press in.
 */
export function Ledger({
  settling,
  groups,
  rest,
  total,
  periodTokens,
  by,
  then,
  sort,
  typed,
  noMatch,
  searched,
  open,
  limit,
  onTip,
  onOpen,
  onTyped,
  onGroup,
  onThen,
  onSwap,
  onSort,
  onMore,
}: {
  settling: boolean;
  groups: Group[];
  rest?: Group;
  total: number;
  periodTokens: number;
  by: GroupKey;
  then: GroupKey | "";
  sort: SortKey;
  typed: string;
  noMatch: boolean;
  searched: string;
  open: string | null;
  limit: number;
  onTip: (t: Tip | null) => void;
  onOpen: (k: string | null) => void;
  onTyped: (v: string) => void;
  onGroup: (v: GroupKey) => void;
  onThen: (v: GroupKey | "") => void;
  onSwap: () => void;
  onSort: (v: SortKey) => void;
  onMore: () => void;
}) {
  const findable = SEARCHABLE.includes(by);
  // The scale is the largest row on screen. The remainder is not a row — it is
  // what is not on screen — so it neither draws a bar nor sets the scale.
  const scale = Math.max(...groups.map((g) => g.tokens), 1);

  return (
    <section className="lsec" data-testid="usage-ledger">
      <div className="headrow">
        <div>
          <h2 data-testid="usage-ledger-heading">
            Where it went, by {GROUPS[by]}
            {then ? ` and then by ${GROUPS[then]}` : ""}
          </h2>
          {/* This replaces the web's `Task · · Tokens` strip, which was a
              three-column header over a two-column grid and already mostly
              empty. */}
          <p className="note" data-testid="usage-ledger-note">
            Billed tokens in this period.
          </p>
        </div>
        <div className="ctl">
          <Choose
            testId="usage-group-by"
            label="Group by"
            value={by}
            options={(Object.keys(GROUPS) as GroupKey[])
              .filter((k) => k !== then)
              .map((k) => ({ value: k, label: `by ${GROUPS[k]}` }))}
            onChange={onGroup}
          />
          <Choose
            testId="usage-then-by"
            label="Then by"
            value={then}
            options={[
              { value: "" as GroupKey | "", label: "then by nothing" },
              ...thenOptions(by).map((k) => ({
                value: k as GroupKey | "",
                label: `then by ${GROUPS[k]}`,
              })),
            ]}
            onChange={onThen}
          />
          {/* **Not drawn until the swap would make a pair somebody could have
              built**, rather than drawn and greyed: a disabled control is how
              an interface says you are being withheld from. Grouped by
              directory, the swap would make *then by directory*, which the
              menu above refuses to offer — so it is absent there too, and
              `maySwap` is the one rule both ends ask. `config/Teams.tsx`'
              rule. */}
          {maySwap(by, then) && (
            <button
              type="button"
              className="btn plain icon"
              data-testid="usage-swap-levels"
              title="Swap the two levels. The totals do not move."
              aria-label="Swap the two levels. The totals do not move."
              onClick={onSwap}
            >
              <Icon of={ArrowDownUp} size={14} />
            </button>
          )}
          <span className="mx-[5px] h-5 w-px bg-line" aria-hidden />
          {/* One control saying one sentence, with the direction as a glyph
              rather than as tracked-out `DESC`. Both halves said a direction
              before and there was no telling which one won. */}
          <Choose
            testId="usage-sort"
            label="Sort by"
            value={sort}
            lead={sort.endsWith("desc") ? ArrowDown : ArrowUp}
            options={SORTS.map((s) => ({ value: s.key, label: sortSay(s.key, by) }))}
            onChange={onSort}
          />
        </div>
      </div>

      {findable && !settling && (
        <div className="mt-4">
          <label className="find" data-testid="usage-find">
            <Icon of={Search} size={14} />
            <input
              data-testid="usage-find-input"
              value={typed}
              placeholder={`Find a ${GROUPS[by]}`}
              aria-label={`Find a ${GROUPS[by]}`}
              onChange={(e) => onTyped(e.target.value)}
            />
          </label>
        </div>
      )}

      {settling ? (
        <LedgerSkeleton />
      ) : noMatch ? (
        /* A control the reader changed, so a note at the row's own left edge
           rather than a blank down the middle of the pane. `bits.tsx`' rule:
           a list empty because nothing exists is a `Blank`; a list empty
           because of a control is a `Note`. */
        <Note
          icon={Search}
          testId="usage-empty-find"
          control={
            <button
              type="button"
              className="btn quiet mt-[7px] h-7 px-2.5"
              data-testid="usage-empty-find-clear"
              onClick={() => onTyped("")}
            >
              Clear the search
            </button>
          }
        >
          Nothing matches <Typed>{searched}</Typed> in this period.
        </Note>
      ) : (
        <>
          <div className="lrows">
            {groups.map((g) => {
              const id = rowKey(g);
              const openable = !!then;
              const expanded = openable && open === id;
              return (
                <Fragment key={id}>
                  <Line
                    g={g}
                    by={by}
                    scale={scale}
                    openable={openable}
                    expanded={expanded}
                    onTip={onTip}
                    onToggle={() => onOpen(open === id ? null : id)}
                  />
                  {expanded && <Children g={g} by={by} onTip={onTip} />}
                </Fragment>
              );
            })}

            {/* Not "smaller": once the order can be reversed, or by name, or
                by date, what is left over is only what is left over. */}
            {rest && (
              <div className="r" data-testid="usage-rest">
                <span className="tx">
                  <b className="rest">
                    {plural(total - groups.length, `more ${GROUPS[by]}`, `more ${GROUPS_MANY[by]}`)}
                  </b>
                  <s>
                    {periodTokens > 0
                      ? `${Math.round((rest.tokens / periodTokens) * 100)}% of the period`
                      : "not shown"}
                  </s>
                </span>
                {/* No meter: the remainder is not a row, it is what is not on
                    screen, so it neither draws a bar nor sets the scale. */}
                <span className="lmeter" aria-hidden />
                <span className="amt">{tokensText(rest.tokens)}</span>
              </div>
            )}
          </div>

          {total > limit && (
            <button type="button" className="btn plain mt-4" data-testid="usage-more" onClick={onMore}>
              Show 25 more
            </button>
          )}
        </>
      )}
    </section>
  );
}

/** The open child block: at most six rows, and what is left said as a line. */
function Children({
  g,
  by,
  onTip,
}: {
  g: Group;
  by: GroupKey;
  onTip: (t: Tip | null) => void;
}) {
  const id = rowKey(g);
  const kids = g.children ?? [];
  if (!kids.length)
    return (
      <div className="lkids" data-testid={`usage-row-children-${id}`}>
        <p className="nothing" data-testid={`usage-row-children-none-${id}`}>
          Nothing to break this down by.
        </p>
      </div>
    );
  const scale = Math.max(...kids.map((k) => k.tokens), 1);
  return (
    <div className="lkids" data-testid={`usage-row-children-${id}`}>
      {kids.slice(0, 6).map((k) => (
        <Line key={rowKey(k)} g={k} by={by} scale={scale} nested onTip={onTip} />
      ))}
      {kids.length > 6 && (
        <p className="nothing" data-testid={`usage-row-children-more-${id}`}>
          {kids.length - 6} more, not shown
        </p>
      )}
    </div>
  );
}

/**
 * One row: a name, one length, a figure.
 *
 * **It is handed no model order, and that is the containment change made
 * structural.** The web threads the page's hue function down to every row to
 * paint a four-segment stack here; this row has nothing to paint with. The
 * split it still opens — `usage-tip` — is drawn by the layer above from the
 * page's own order, so the hues never reach a row at all.
 */
function Line({
  g,
  by,
  scale,
  nested,
  openable,
  expanded,
  onTip,
  onToggle,
}: {
  g: Group;
  by: GroupKey;
  scale: number;
  nested?: boolean;
  openable?: boolean;
  expanded?: boolean;
  onTip: (t: Tip | null) => void;
  onToggle?: () => void;
}) {
  const id = rowKey(g);
  const head = g.name ? named(g.name) : unnamed(g, by);
  const width = meterWidth(g.tokens, scale, !!nested);
  /* **The only surviving route to a row's split besides *then by model*.**
     The meter below is one neutral length; this is where the four hues are
     still readable off a row, and it is a frame rather than the page. */
  const show = (e: { clientX: number; clientY: number }) =>
    onTip({ x: e.clientX, y: e.clientY, from: "row", head, models: g.models });

  return (
    <div
      className={nested ? "r sub" : "r"}
      data-testid={`usage-row-${id}`}
      role={openable ? "button" : undefined}
      tabIndex={openable ? 0 : undefined}
      aria-expanded={openable ? expanded : undefined}
      onPointerMove={show}
      onPointerLeave={() => onTip(null)}
      onClick={openable ? onToggle : undefined}
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
      {openable && (
        <span className="chev" data-testid={`usage-row-chevron-${id}`} aria-hidden>
          <Icon of={ChevronRight} size={14} />
        </span>
      )}
      <span className="tx">
        <b data-testid={`usage-row-name-${id}`} className={g.name ? undefined : "unnamed"}>
          {head}
        </b>
        {!nested && (
          <s>
            {/* The key, then the sentence — with air between them, or
                `FIRE-412` and `9 workspaces` read as one word. */}
            {g.key && by === "task" && <span className="mr-3.5 font-mono text-ui">{g.key}</span>}
            {detail(g, by)}
          </s>
        )}
      </span>
      {/* **One length, filled `--color-dim`.** The change that makes the
          containment rule true rather than aspirational: the web stacks up to
          four series hues here, on every row, which is the mapping leaving the
          chart and tiling the page. */}
      <span className="lmeter" data-testid={`usage-row-meter-${id}`}>
        <span className="fill" style={{ width: `${width}%` }}>
          <i style={{ background: METER_FILL }} />
        </span>
      </span>
      <span className="amt" data-testid={`usage-row-tokens-${id}`}>
        {tokensText(g.tokens)}
      </span>
    </div>
  );
}

/**
 * An agent is stored as its variant and read as its name.
 *
 * Applied to the model column too, and not only to the agent one. A turn whose
 * agent named no model is billed to the agent instead — which is what Cursor
 * on Auto does on every turn — so the variant turns up under models as well.
 */
function named(name: string) {
  return AGENT_LABEL[name as keyof typeof AGENT_LABEL] ?? name;
}

/* ── the hover layer — one component, two openers ────────────────────── */

export type Tip = { x: number; y: number; from: "chart" | "row"; head: string; models: ByModel[] };

/**
 * Where the hover layer's state lives — **outside the tree**.
 *
 * It was `useState` on the pane, and a pointer move is a coordinate change:
 * dragging across one ledger row re-rendered the chart, twenty-five rows,
 * their meters and the Limits section, sixty times a second, to move one card
 * four pixels. Nothing above the layer depends on where the pointer is.
 *
 * So the openers write to a store and only `TipLayer` subscribes. The setter
 * is stable for the life of the pane, which is also what keeps it out of
 * every child's dependency list.
 */
export type TipStore = {
  get: () => Tip | null;
  set: (tip: Tip | null) => void;
  subscribe: (listener: () => void) => () => void;
};

export function makeTipStore(): TipStore {
  let tip: Tip | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => tip,
    set: (next) => {
      tip = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/**
 * What a column *or a row* is made of, without having to open anything.
 *
 * On `body` and `fixed`, for the reason `Pop` gives: a tooltip opened from
 * inside a scrolling sheet has to be placed against the viewport or it is
 * drawn in the wrong place the moment anything above it moves.
 *
 * **Two openers is the point.** On the web this belonged to the chart; here a
 * ledger row opens it too, and under the containment rule that is the only
 * place a row's model split survives besides *then by model*. `data-from` says
 * which, so the two are distinguishable without guessing at coordinates.
 *
 * It enhances and never gates — every number in here is also reachable under
 * *then by model*, which needs no pointer at all.
 */
export function TipLayer({ store, models }: { store: TipStore; models: string[] }) {
  /* The one subscriber. `getServerSnapshot` is the same reader because the
     store is per-pane rather than global — there is nothing to hydrate from
     and nothing shared across renders of it. */
  const tip = useSyncExternalStore(store.subscribe, store.get, store.get);
  if (!tip || typeof document === "undefined") return null;
  return createPortal(<Tip tip={tip} models={models} />, document.body);
}

/** The card itself, so it can be drawn without a DOM to portal into. */
export function Tip({ tip, models }: { tip: Tip; models: string[] }) {
  const layer = seriesIn("usage-tip", models);
  const rows = liveModels(tip.models, models);
  const total = rows.reduce((a, m) => a + m.tokens, 0);
  const width = typeof window === "undefined" ? 1200 : window.innerWidth;

  return (
    <div
      className="tip"
      role="status"
      aria-live="polite"
      data-testid={layer.testId}
      data-from={tip.from}
      style={{
        left: Math.min(Math.max(tip.x, 120), width - 120),
        top: Math.max(tip.y - 14, 80),
      }}
    >
      <h3 data-testid="usage-tip-head">{tip.head}</h3>
      {rows.map((m) => (
        <div key={m.model} className="ln" data-testid={`usage-tip-row-${m.model}`}>
          <i style={{ background: layer.hue(m.model) }} />
          {/* The model id as the wire spells it, the way the key does — this
              is the same mapping read at a different distance. */}
          <span className="m">{m.model}</span>
          <span className="v">{tokensText(m.tokens)}</span>
        </div>
      ))}
      <div className="tot" data-testid="usage-tip-total">
        <span className="a">Total</span>
        <span className="b">{tokensText(total)}</span>
      </div>
    </div>
  );
}

/* ── the scope picker ────────────────────────────────────────────────── */

/**
 * Who to narrow to.
 *
 * A search rather than a list, because a row of names stops working at the
 * second team and this installation may have two hundred people in it. The
 * ranked ledger below is still the way most people find somebody — this is the
 * escape hatch for when you already know who you want.
 */
function ScopePicker({
  anchor,
  teams,
  colleagues,
  onPick,
  onClose,
}: {
  anchor: HTMLElement;
  teams: { id: string; name: string }[];
  colleagues: { id: string; username: string }[];
  onPick: (s: Scope) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const hits = scopeMatches(q, teams, colleagues);
  const nothing = !hits.wide.length && !hits.teams.length && !hits.people.length;

  return (
    <Pop anchor={anchor} onClose={onClose} width={290} align="left">
      <div data-testid="usage-scope-picker" className="flex min-h-0 flex-col">
        <label className="mfind">
          <Icon of={Search} size={14} />
          <input
            autoFocus
            data-testid="usage-scope-search"
            value={q}
            placeholder="Search people and teams"
            aria-label="Search people and teams"
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        {/* The header stays and the list gives way, which is what `Pop`'s
            height cap is a column for. */}
        <div className="scr min-h-0 overflow-y-auto">
          {nothing && <p className="empty">Nobody matches “{q}”.</p>}
          {hits.wide.length > 0 && <p className="mlabel">Scope</p>}
          {hits.wide.map((w) => (
            <Option key={w.id} id={w.id} label={w.label} onPick={() => onPick(w.scope)} />
          ))}
          {hits.teams.length > 0 && <p className="mlabel">Teams</p>}
          {hits.teams.map((t) => (
            <Option
              key={t.id}
              id={t.id}
              label={t.name}
              onPick={() => onPick({ kind: "team", id: t.id, name: t.name })}
            />
          ))}
          {hits.people.length > 0 && <p className="mlabel">People</p>}
          {hits.people.map((c) => (
            <Option
              key={c.id}
              id={c.id}
              label={c.username}
              note={`u/${c.username}`}
              onPick={() => onPick({ kind: "person", id: c.id, name: c.username })}
            />
          ))}
        </div>
      </div>
    </Pop>
  );
}

function Option({
  id,
  label,
  note,
  onPick,
}: {
  id: string;
  label: string;
  note?: string;
  onPick: () => void;
}) {
  return (
    <button type="button" role="menuitemradio" aria-checked={false} className="mi" data-testid={`usage-scope-option-${id}`} onClick={onPick}>
      <span className="sp">{label}</span>
      {note && <span className="note">{note}</span>}
    </button>
  );
}

/* ── limits, last ────────────────────────────────────────────────────── */

/**
 * What each provider last told us about its own ceiling.
 *
 * A different book from everything above it, and deliberately not joined to
 * it: a limit is the provider's accounting on the provider's clock, and it
 * cannot be worked out from the tokens we counted.
 *
 * Claude Code reports no percentage, so those rows get no meter. **The empty
 * space is the finding, not a gap to fill** with a word-shaped box.
 *
 * **And a read that failed is not that finding.** Nothing drawn at all is how
 * this section says *no subscription has reported a ceiling*, which is a real
 * answer somebody can act on; drawing the same nothing over a request that
 * never came back says it about a fact nobody has. The two were folded
 * together — no line, no retry, no way to tell — which is the defect this
 * pane's own note warns about one paragraph up: *not knowing yet is a
 * different thing*.
 */
function Limits({
  feed,
}: {
  feed: { data: Account[]; loading: boolean; error: string | null; onRetry: () => void };
}) {
  const [shown, setShown] = useState(10);
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const accounts = feed.data;
  const pending = feed.loading;

  // Grouped by subscription, because a provider meters one account several
  // ways at once — Kimi keeps a rolling five hours, a month, and coding inside
  // that month — and a row each put the same name, engine and folder on screen
  // three times. That reads as three subscriptions, which is the opposite of
  // what naming them was for.
  const groups = accounts
    .map((account) => ({
      account,
      limits: [...(account.limits ?? [])].sort((a, b) => fuller(a, b, order)),
    }))
    .filter((g) => g.limits.length)
    // An account is ranked by its fullest window: the one nearest running out
    // is the reason to look at it, whatever the others say.
    .sort((x, y) => {
      const a = peak(x.limits);
      const b = peak(y.limits);
      if (a == null && b == null) return 0;
      if (a == null) return 1;
      if (b == null) return -1;
      return order === "desc" ? b - a : a - b;
    });

  /* Said at the row's own left edge rather than as a plate down the middle:
     this is one section of a pane that is otherwise fine, and a centred
     refusal here would read as the whole screen having failed. `bits.tsx`'
     two shapes, and this is the `Note` one. The heading stays, because a
     section that cannot be filled is still a section. */
  const unread = !pending && !!feed.error;

  // Nothing at all is a real answer — no subscription has reported a limit —
  // and it is drawn as nothing. Not knowing yet is a different thing, and it
  // is the line above this one.
  if (!pending && !unread && !groups.length) return null;

  const page = groups.slice(0, shown);
  const now = Date.now();

  return (
    <section className="lsec" data-testid="usage-limits">
      <div className="headrow">
        <div>
          <h2>Limits</h2>
          <p className="note">
            What each provider last told us about its own ceiling, on the provider’s clock. Not the
            period above.
          </p>
        </div>
        {!pending && !unread && groups.length > 1 && (
          <div className="ctl">
            <Choose
              testId="usage-limits-order"
              label="Order limits by"
              value={order}
              options={[
                { value: "desc" as const, label: "most used first" },
                { value: "asc" as const, label: "least used first" },
              ]}
              onChange={(v) => {
                setOrder(v);
                setShown(10);
              }}
            />
          </div>
        )}
      </div>

      {unread ? (
        <Note
          icon={TriangleAlert}
          testId="usage-limits-error"
          control={
            <button
              type="button"
              className="btn quiet mt-[7px] h-7 px-2.5"
              data-testid="usage-limits-retry"
              onClick={feed.onRetry}
            >
              Try again
            </button>
          }
        >
          {feed.error} What each provider last said is on the server, not in this window.
        </Note>
      ) : (
      <div className="limits">
        {pending
          ? [0, 1, 2, 3].map((i) => (
              <div key={i} className="lim" role="status" aria-label="Loading limits">
                <div className="who">
                  <span className="settling h-2.5 w-[116px]" />
                  <span className="settling h-2 w-[82px]" />
                </div>
                {Array.from({ length: i % 2 === 1 ? 2 : 1 }, (_, n) => (
                  <div key={n} className="gauge">
                    <div className="ln">
                      <span className="settling h-2 w-[94px]" />
                      <span className="sp" />
                      <span className="settling h-2 w-[52px]" />
                    </div>
                    <span className="settling mt-1.5 block h-[3px] rounded-full" />
                  </div>
                ))}
              </div>
            ))
          : page.map(({ account, limits }) => (
              <div key={account.id} className="lim" data-testid={`usage-limit-${account.id}`}>
                {/* Said once, however many ways the provider meters it. */}
                <div className="who">
                  <span className="nm">{account.name}</span>
                  <span className="pv">{provider(account.kind)}</span>
                  <span className="fd">{folder(account.path)}</span>
                </div>
                {limits.map((l) => (
                  <Gauge key={l.scope} limit={l} account={account.id} now={now} />
                ))}
              </div>
            ))}
      </div>
      )}

      {!pending && !unread && groups.length > shown && (
        <button
          type="button"
          className="btn plain mt-5"
          data-testid="usage-limits-more"
          onClick={() => setShown((n) => n + 10)}
        >
          Show more
          <span className="cv">{plural(groups.length - shown, "left", "left")}</span>
        </button>
      )}
    </section>
  );
}

function Gauge({ limit, account, now }: { limit: Limit; account: string; now: number }) {
  const shade = tone(limit);
  const pct = limit.usedPercent;

  return (
    <div className="gauge" data-testid={`usage-limit-${account}-${limit.scope}`}>
      {/* The window and when it turns over on one line, because they are one
          fact in two halves, with the figure against the right edge where the
          eye can run down a column of them. */}
      <div className="ln">
        <span className="w">{windowSaid(limit.scope)}</span>
        <span className="when">{whenSaid(limit, now)}</span>
        <span className="sp" />
        <span className={`pc ${TONE[shade]}`}>{usedSaid(limit)}</span>
      </div>
      {pct != null && (
        <div
          className="track"
          data-testid={`usage-limit-meter-${account}-${limit.scope}`}
          style={{ background: `color-mix(in srgb, var(--color-${shade}) 20%, var(--color-panel))` }}
        >
          <i
            style={{
              width: `${Math.min(100, Math.max(0, pct))}%`,
              background: `var(--color-${shade})`,
            }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * The three signal classes, written out.
 *
 * Tailwind reads the source for class names, so `text-${shade}` compiles to
 * nothing at all — which is the shape of bug that left `text-amber` with no
 * colour when the desk's sheet was missing the token. Written literally, they
 * are generated.
 */
const TONE = { sage: "text-sage", amber: "text-amber", brick: "text-brick" } as const;

/** What to call the engine, in the one word a crowded line has room for. */
const provider = (kind: string) => AGENT_SHORT[kind as keyof typeof AGENT_SHORT] ?? kind.toLowerCase();
