/**
 * The import review: what a folder of `PROFILE.md` files would do, before
 * anything is written.
 *
 * **This is the Skills import review with a diff in it** — the same drop
 * surface, the same 16px tick, the same sticky foot, the same vocabulary. Four
 * things are new because profiles are not skills, and each one is why the
 * screen exists at all:
 *
 * - A skill is append-only; a profile is one mutable row. There is no version
 *   to recover, so **the diff is the whole safeguard**. All sixteen fields are
 *   always drawn, unchanged ones quietly, and the diff wears no colour unless
 *   something resets.
 * - A profile's references point outward, so **resolution can fail**, and
 *   failing is a refusal rather than a skip.
 * - The set applies as one, so **one refusal stops the drop**. The primary is
 *   unavailable and the screen says what makes it available again.
 * - An absent key is a reset, so a deleted line changes the profile. **It must
 *   not be possible to lose a setting without having been shown it.**
 *
 * Two interaction decisions departed from the sibling on purpose. A blocked
 * profile arrives **ticked and expanded**, because Skills unticks what it
 * cannot import and loses nothing by it, while here a quiet untick is a
 * half-library — so excluding one is an act somebody performs. And rows stay
 * in **file order**, never sorted by state, because you are checking a folder
 * you know and a name has to be where you expect it. Visibility comes from the
 * banner, the foot, and filter pills once the list is long enough to need
 * narrowing.
 *
 * **Driven by a plan, and only by a plan.** Everything on screen reads an
 * `ImportPlan`; the drop that produces one and the apply that spends it are
 * #358. `import-plans.ts` holds a specimen per state, which is what let every
 * state here be built and photographed before either existed.
 */
import { useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  FileText,
  Info,
  Loader2,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import type { CandidateDecision, FieldDiff, ImportPlan, PlanEntry, PlanProblem } from "~/api/generated/model";
import {
  FILTER_AT,
  aboutADuplicateName,
  appliability,
  conditionOf,
  bucketOf,
  composition,
  diffOf,
  foot as footSays,
  grouped,
  heading,
  included,
  labelOf,
  moved,
  openOnArrival,
  outcomeOf,
  pipOf,
  resets,
  stateWord,
  tally,
  unchanged,
  type Bucket,
  type Selection,
} from "./import-plan";

export function ImportProfiles({
  plan,
  refused = null,
  applying = false,
  onClose,
  onApply,
  onAnswer,
}: {
  plan: ImportPlan;
  /**
   * The drop was refused whole, as the sentence to show.
   *
   * **Not a plan.** A drop past one of `PlanLimits`' bounds comes back from
   * `plan()` as `Refused`, which the API returns as an `InvalidRequest` — so
   * there is no `ImportPlan` with no entries and a reason, and a review handed
   * one would be drawing a shape the server cannot produce. The refusal is a
   * fact about the drop rather than about any one profile, and it arrives here
   * from whoever made the call.
   */
  refused?: string | null;
  /** The apply is in flight. One call, applying the plan that was shown. */
  applying?: boolean;
  onClose: () => void;
  onApply: (sel: Selection) => void;
  /**
   * An answer to a candidate.
   *
   * Handed up rather than resolved here: the answer goes back through
   * `ProfileDrop.answers` and the server plans again, which is the only way the
   * sixteen fields can be diffed against the row that was chosen. The row
   * states its consequence in words until that plan arrives.
   */
  onAnswer?: (key: string, answer: CandidateDecision) => void;
}) {
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [answers, setAnswers] = useState<Record<string, CandidateDecision>>({});
  /* Blocked rows and rows carrying a reset arrive expanded: the two things
     that can surprise you are never behind a disclosure. Keyed on the plan so
     a replanned drop opens its own, rather than keeping the last one's. */
  const [open, setOpen] = useState<ReadonlySet<string>>(() => openOnArrival(plan));
  const [shownPlan, setShownPlan] = useState(plan);
  const [filter, setFilter] = useState<Bucket | "all">("all");
  const [bodies, setBodies] = useState<ReadonlySet<string>>(new Set());
  const [copied, setCopied] = useState(false);

  if (shownPlan !== plan) {
    setShownPlan(plan);
    setOpen(openOnArrival(plan));
  }

  const sel: Selection = useMemo(() => ({ excluded, answers }), [excluded, answers]);

  if (refused)
    return (
      <div className="pg">
        <Back onClose={onClose} />
        <h2 className="mt-3 text-display text-bone">Nothing in this drop was read</h2>
        <Block tone="brick" icon={<ShieldAlert className="h-4 w-4" strokeWidth={1.75} />}>
          <h3>Too much was dropped at once</h3>
          <p>{refused}</p>
        </Block>
        <div className="formfoot">
          <span className="msg bad" aria-live="polite">
            Nothing was written. Drop a smaller folder and this screen comes back.
          </span>
          <button onClick={onClose} className="btn quiet">
            Cancel
          </button>
        </div>
      </div>
    );
  const t = tally(plan, sel);
  const can = appliability(plan, sel);
  const f = footSays(plan, sel);

  const flip = (set: ReadonlySet<string>, key: string) => {
    const next = new Set(set);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  };

  const answer = (entry: PlanEntry, a: CandidateDecision) => {
    setAnswers((was) => ({ ...was, [entry.path]: a }));
    /* Held by path, because that is the row; handed up by key, because that is
       what `CandidateAnswer` carries back. */
    onAnswer?.(entry.key, a);
  };

  /* Every condition as `path:line — message`, because the next thing anybody
     does with a blocked drop is open the files in an editor. */
  const copyErrors = () => {
    const lines = plan.entries.flatMap((e) =>
      e.outcome.kind === "blocked"
        ? e.outcome.problems.map((p) => `${p.path}:${p.line} — ${p.says}`)
        : [],
    );
    void navigator.clipboard?.writeText(lines.join("\n"));
    setCopied(true);
  };

  const excludeBlocked = () =>
    setExcluded((was) => {
      const next = new Set(was);
      for (const e of plan.entries) if (outcomeOf(e, sel) === "blocked") next.add(e.path);
      return next;
    });

  const shown = plan.entries.filter((e) => filter === "all" || bucketOf(outcomeOf(e, sel)) === filter);

  return (
    <div className="pg">
      <Back onClose={onClose} />

      <h2 className="mt-3 text-display text-bone">{heading(plan)}</h2>
      <p className="mt-2 max-w-[62ch] text-body text-dim">
        Read and checked, nothing written. {composition(plan, sel)}
      </p>

      <Banner
        plan={plan}
        sel={sel}
        reasons={can.reasons}
        copied={copied}
        onCopy={copyErrors}
        onExcludeBlocked={excludeBlocked}
      />

      {plan.entries.length > FILTER_AT && (
        <div className="filters" role="group" aria-label="Narrow the list">
          {(
            [
              ["all", "All", t.all],
              ["blocked", "Blocked", t.blocked],
              ["candidate", "Waiting on an answer", t.candidate],
              ["overwrite", "Will overwrite", t.overwrite],
              ["new", "New", t.new],
            ] as [Bucket | "all", string, number][]
          )
            .filter(([, , n]) => n > 0)
            .map(([key, label, n]) => (
              <button key={key} className="fp" aria-pressed={filter === key} onClick={() => setFilter(key)}>
                {key !== "all" && <Pip kind={key === "candidate" ? "asking" : key} bare />}
                {label} <span className="tabular-nums text-mute">{n}</span>
              </button>
            ))}
        </div>
      )}

      {plan.entries.length > 0 && (
        <div className={`mt-5 ${applying ? "pointer-events-none opacity-45" : ""}`}>
          {shown.map((entry) => (
            <Entry
              key={entry.path}
              entry={entry}
              sel={sel}
              on={included(sel, entry)}
              open={open.has(entry.path)}
              bodyOpen={bodies.has(entry.path)}
              onToggle={() => setExcluded((was) => flip(was, entry.path))}
              onOpen={() => setOpen((was) => flip(was, entry.path))}
              onBody={() => setBodies((was) => flip(was, entry.path))}
              onAnswer={(a) => answer(entry, a)}
            />
          ))}
        </div>
      )}

      <Ignored paths={plan.ignored} />

      {applying && (
        <div className="mt-6 flex items-center gap-2.5 text-ui text-dim">
          <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
          Writing {t.in === 1 ? "1 profile" : `${t.in} profiles`}…
        </div>
      )}

      <div className="formfoot">
        {/* **Announced, not only drawn.** Unticking the last blocked profile
            makes the primary available, and somebody not watching the button
            should be told that in words. */}
        <span className={`msg${f.tone === "plain" ? "" : ` ${f.tone}`}`} aria-live="polite">
          {f.lead && <b>{f.lead}</b>}
          {f.lead && " "}
          {f.rest}
          {f.excluded > 0 && <span className="text-mute"> · {f.excluded} excluded</span>}
        </span>
        <button onClick={onClose} className="btn quiet">
          Cancel
        </button>
        {/* **It keeps its real label while disabled.** A primary that relabels
            itself to "Can't import" has thrown away what it would do in order
            to repeat the sentence beside it. */}
        <button
          disabled={!can.appliable || applying}
          onClick={() => onApply(sel)}
          className="btn primary"
        >
          {applying ? "Importing…" : t.in === 1 ? "Import 1 profile" : `Import ${t.in} profiles`}
        </button>
      </div>
    </div>
  );
}

const Back = ({ onClose }: { onClose: () => void }) => (
  <button onClick={onClose} className="flex items-center gap-1 text-meta text-mute hover:text-bone">
    <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} />
    All profiles
  </button>
);

/**
 * One banner, in the order of what stops you: a refusal, then a reset, then
 * the standing note on a drop with nothing to flag.
 *
 * Each answers three things in a scan — what is wrong, which profile, and the
 * ways out. The all-or-nothing behaviour is a consequence said in a few words
 * and never a description of the transaction; a banner lifted out of a
 * specification's atomicity section is what the copy pass on this screen
 * existed to undo.
 */
function Banner({
  plan,
  sel,
  reasons,
  copied,
  onCopy,
  onExcludeBlocked,
}: {
  plan: ImportPlan;
  sel: Selection;
  reasons: string[];
  copied: boolean;
  onCopy: () => void;
  onExcludeBlocked: () => void;
}) {
  const t = tally(plan, sel);

  /* A drop with nothing in it. The reason is the server's when it has one and
     the screen's own when it does not, but there is always one: a dead primary
     with no sentence beside it is the failure this feature exists to remove. */
  if (plan.entries.length === 0)
    return (
      <Block tone="brick" icon={<ShieldAlert className="h-4 w-4" strokeWidth={1.75} />}>
        <h3>Nothing here was read</h3>
        {reasons.map((r) => (
          <p key={r}>{r}</p>
        ))}
      </Block>
    );

  if (t.blocking > 0) {
    const one = plan.entries.find((e) => included(sel, e) && outcomeOf(e, sel) === "blocked");
    /* **The heading is the diagnosis, not the word "blocked".** The pip on the
       row already says blocked; what a scan needs from the top of the page is
       which profile and what is wrong with it. The body then carries the
       all-or-nothing consequence, which is a different fact rather than this
       one said twice. */
    const condition = one ? conditionOf(one) : null;
    return (
      <Block tone="brick" icon={<ShieldAlert className="h-4 w-4" strokeWidth={1.75} />}>
        <h3>
          {t.blocking === 1 && one
            ? condition
              ? `${labelOf(one)}: ${condition}`
              : `${labelOf(one)} cannot be imported`
            : `${t.blocking} profiles cannot be imported`}
        </h3>
        {reasons.map((r) => (
          <p key={r}>{r}</p>
        ))}
        <div className="acts">
          <button className="btn plain" onClick={onExcludeBlocked}>
            {t.blocking === 1 && one ? `Exclude ${labelOf(one)}` : `Exclude the ${t.blocking} blocked`}
          </button>
          <button className="btn quiet" onClick={onCopy}>
            <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />
            {copied ? "Copied" : "Copy the errors"}
          </button>
        </div>
      </Block>
    );
  }

  /* An unanswered candidate holds the import up and is not a fault, so it is
     said without a severity: the answer is on the row, and this points at it. */
  if (t.unanswered > 0)
    return (
      <Block tone="slate" icon={<Info className="h-4 w-4" strokeWidth={1.75} />}>
        <h3>
          {t.unanswered === 1
            ? "One profile needs an answer"
            : `${t.unanswered} profiles need an answer`}
        </h3>
        {reasons.map((r) => (
          <p key={r}>{r}</p>
        ))}
      </Block>
    );

  const back = resets(plan, sel);
  if (back.length > 0)
    return (
      <Block tone="amber" icon={<TriangleAlert className="h-4 w-4" strokeWidth={1.75} />}>
        <h3>
          {back.length === 1
            ? "One field would go back to its default"
            : `${back.length} fields would go back to their defaults`}
        </h3>
        <p>
          {back.map((r, i) => (
            <span key={`${r.profile}.${r.field}`}>
              {i > 0 && ", "}
              <span className="font-mono text-amber">{r.field}</span> on <b>{r.profile}</b>
            </span>
          ))}
          {back.length === 1
            ? " is absent from the file, so importing takes it back to its default. The diff names the value."
            : " are absent from the files, so importing takes each back to its default. The diff names the values."}
        </p>
        {/* The one fact on this screen about not being able to go back. */}
        <p>A profile has no version history, so an import cannot be undone.</p>
      </Block>
    );

  if (t.all > 0 && t.new === t.all)
    return (
      <Block tone="slate" icon={<Info className="h-4 w-4" strokeWidth={1.75} />}>
        <h3>None of these exists here yet</h3>
        <p>Each one would be created from its file. Nothing already here is touched.</p>
      </Block>
    );

  return null;
}

/** `.review`'s 2px rule, which spends two pixels rather than a filled panel. */
function Block({
  tone,
  icon,
  children,
}: {
  tone: "brick" | "amber" | "slate";
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="review" data-tone={tone}>
      <div className="flex items-start gap-3">
        <span className="mt-px shrink-0">{icon}</span>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}

/* ── One profile in the drop ──────────────────────────────────────────── */

function Entry({
  entry,
  sel,
  on,
  open,
  bodyOpen,
  onToggle,
  onOpen,
  onBody,
  onAnswer,
}: {
  entry: PlanEntry;
  sel: Selection;
  on: boolean;
  open: boolean;
  bodyOpen: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onBody: () => void;
  onAnswer: (a: CandidateDecision) => void;
}) {
  const kind = outcomeOf(entry, sel);
  const name = labelOf(entry);
  const diff = diffOf(entry);
  const o = entry.outcome;

  return (
    <div className="imp" data-state={kind} data-open={open} data-off={!on}>
      <div className="imp-top">
        {/* The Skills review's own checkbox, at the same 16px, in the same
            place. A blocked row is **ticked and enabled**: excluding it is a
            decision somebody makes, not a default they have to notice. */}
        <button
          role="checkbox"
          aria-checked={on}
          aria-label={`Include ${name} in this import`}
          title={`Include ${name} in this import`}
          onClick={onToggle}
          className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded bg-panel ring-1 ${
            on ? "bg-raise ring-dim" : "ring-line"
          }`}
        >
          {on && <span className="block h-1.5 w-2.5 -translate-y-px rotate-[-45deg] border-b-2 border-l-2 border-bone" />}
        </button>

        {/* **A row with nothing to expand is not a disclosure.** A blocked
            entry carries no diff — `PlanBlocked` has none to carry — so it
            gets no chevron and no expander, rather than a control that
            rotates and reveals nothing. */}
        <Open on={!!diff} open={open} onOpen={onOpen}>
          <span className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1.5">
            {/* A profile's name is a name. Paths, keys and diffs keep the mono
                voice; this is not one of them. */}
            <span className={`text-title font-medium ${kind === "blocked" ? "text-text" : "text-bone"}`}>
              {name}
            </span>
            <Pip kind={pipOf(entry, sel)} word={stateWord(entry, sel)} />
            <span className="font-mono text-meta text-mute">{entry.path}</span>
          </span>

          <Summary entry={entry} sel={sel} />

          {o.kind === "blocked" && o.problems.map((p) => <Blocked key={`${p.path}:${p.line}`} problem={p} />)}

          {o.kind === "candidate" &&
            o.proposals.map((p) => (
              <span key={p.profile.id} className="mt-2 block max-w-[76ch] text-meta leading-relaxed text-text">
                {p.says}
              </span>
            ))}

          {/* **Amber only where amber means something.** A name that may be a
              duplicate is the one warning it is spent on; anything else takes
              the neutral rule, so a second kind of warning cannot quietly
              become a third thing wearing the screen's one caution colour. */}
          {entry.warnings.map((w) => {
            const amber = aboutADuplicateName(w);
            return (
              <span
                key={`${w.path}:${w.line}:${w.says}`}
                data-warn={amber ? "duplicate-name" : "other"}
                className={`mt-2 block max-w-[76ch] border-l-2 pl-3 text-meta leading-relaxed text-text ${
                  amber ? "border-amber-soft" : "border-line"
                }`}
              >
                {w.key && <span className={`font-mono ${amber ? "text-amber" : "text-dim"}`}>{w.key}</span>}
                {w.key && " "}
                {w.says}
              </span>
            );
          })}
        </Open>

        {diff && (
          <ChevronRight
            className={`mt-0.5 h-3.5 w-3.5 shrink-0 text-mute transition-transform ${open ? "rotate-90" : ""}`}
            strokeWidth={2}
          />
        )}
      </div>

      {o.kind === "candidate" && <Candidate entry={entry} sel={sel} onAnswer={onAnswer} />}

      {/* **A file that failed to parse shows its error and no field panel.**
          It has no values to show, and `PlanBlocked` carries none — so this is
          true of every blocked entry, not only an unparseable one. */}
      {open && diff && (
        <div className="pl-7">
          <Diff entry={entry} diff={diff} bodyOpen={bodyOpen} onBody={onBody} />
        </div>
      )}
    </div>
  );
}

/**
 * What would change, collapsed — **the fields named, not counted.**
 *
 * A row reading "2 changes" makes expanding it the only way to find out what
 * they were, on the one screen whose job is that nothing is missed.
 */
function Summary({ entry, sel }: { entry: PlanEntry; sel: Selection }) {
  const kind = outcomeOf(entry, sel);
  const o = entry.outcome;
  const diff = diffOf(entry);
  const parts: React.ReactNode[] = [];

  if (o.kind === "blocked")
    parts.push(
      <span key="n">
        {o.problems.length} {o.problems.length === 1 ? "thing to fix" : "things to fix"}
      </span>,
    );
  else if (kind === "new")
    parts.push(
      <span key="made">
        Creates <b className="font-normal text-dim">{labelOf(entry)}</b>
      </span>,
      <span key="where">
        filed in <span className="font-mono">{o.kind === "new" ? o.filed : "u/kevin"}</span>
      </span>,
      <span key="all">all 16 fields set from the file</span>,
    );
  else if (diff) {
    const m = moved(diff);
    if (o.kind === "rename")
      parts.push(
        <span key="ren">
          Renames <b className="font-normal text-dim">{o.from}</b> to{" "}
          <b className="font-normal text-dim">{o.to}</b>
        </span>,
      );
    const rest = m.filter((x) => !(o.kind === "rename" && x.field === "name"));
    if (rest.length === 0 && o.kind !== "rename") parts.push(<span key="same">All 16 fields match</span>);
    else if (rest.length > 0)
      parts.push(
        <span key="moved">
          {o.kind === "rename" ? "" : `${rest.length} ${rest.length === 1 ? "change" : "changes"}: `}
          {rest.map((x, i) => (
            <span key={x.field}>
              {i > 0 && ", "}
              <span className="font-mono text-dim">{x.field}</span>
              {x.reset && <span className="text-amber"> reset to its default</span>}
            </span>
          ))}
        </span>,
      );
    if (m.length > 0) parts.push(<span key="un">{unchanged(diff)} unchanged</span>);
  }

  /* The moment a row stops being matched by its name and starts being matched
     by its key. It happens once per profile per installation, and it is worth
     saying because it is what makes the next drop of this folder unambiguous. */
  if ((o.kind === "overwrite" || o.kind === "rename") && o.adoptsKey)
    parts.push(<span key="key">matched by its name; later drops of this folder match it exactly</span>);

  if (parts.length === 0) return null;
  return (
    <span className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-meta text-mute">{parts}</span>
  );
}

/**
 * One named refusal: the key in mono, the sentence, and the line to open.
 *
 * Mono for the key because the individual characters are what carry the
 * meaning and this is the place that is about them. The value, which entry of
 * a list it was, and what this installation does have instead all arrive
 * inside `says` — `PlanProblem` has no field for any of them.
 */
function Blocked({ problem }: { problem: PlanProblem }) {
  return (
    <span className="mt-2 block border-l-2 border-brick pl-3">
      {problem.key && <span className="block font-mono text-code text-brick">{problem.key}</span>}
      <span className="mt-0.5 block max-w-[76ch] text-meta leading-relaxed text-text">{problem.says}</span>
      <span className="mt-0.5 block font-mono text-meta text-mute">
        {problem.path}:{problem.line}
      </span>
    </span>
  );
}

/**
 * The candidate's two answers — **a control, not a warning.**
 *
 * The importer never guesses an identity, so the review hands the choice over.
 * There is no default and no third answer: a default here is a guess with a
 * nicer name, and an unanswered row keeps the whole drop unappliable, which is
 * what `appliable` and `whyNot` already say.
 *
 * The recessed pair is `AddSkill`'s, used for the same reason in the same
 * place: a per-row decision that changes what the primary will do.
 */
function Candidate({
  entry,
  sel,
  onAnswer,
}: {
  entry: PlanEntry;
  sel: Selection;
  onAnswer: (a: CandidateDecision) => void;
}) {
  if (entry.outcome.kind !== "candidate") return null;
  const name = labelOf(entry);
  const chosen = sel.answers[entry.path];
  return (
    <div className="pb-3 pl-7">
      {entry.outcome.proposals.map((p) => (
        <div key={`${p.profile.id}-pair`} className="pickpair" role="radiogroup" aria-label={`Is this ${p.profile.name}?`}>
          <button
            role="radio"
            aria-checked={chosen?.kind === "sameProfile" && chosen.profile === p.profile.id}
            onClick={() => onAnswer({ kind: "sameProfile", profile: p.profile.id })}
          >
            This is <b>{p.profile.name}</b>
          </button>
          <button
            role="radio"
            aria-checked={chosen?.kind === "newProfile"}
            onClick={() => onAnswer({ kind: "newProfile" })}
          >
            A new profile
          </button>
        </div>
      ))}
      {chosen && (
        <p className="mt-2 max-w-[76ch] text-meta leading-relaxed text-dim">
          {chosen.kind === "newProfile"
            ? `Creates ${name}. ${
                entry.outcome.proposals[0]?.profile.name ?? "The other profile"
              } stays as it is, so you would have both.`
            : `Overwrites ${
                entry.outcome.proposals.find((p) => p.profile.id === chosen.profile)?.profile.name ?? "it"
              }, field by field.`}
        </p>
      )}
    </div>
  );
}

/* ── The field-by-field diff ──────────────────────────────────────────── */

/**
 * All sixteen fields, grouped the way the file groups them.
 *
 * An unchanged field costs one line and no colour. The alternative —
 * "14 unchanged" behind a disclosure — makes the disclosure load-bearing on a
 * screen whose only job is that nothing is lost unseen. The visibility of the
 * one that moved comes from weight, and from a tint on the single row that
 * resets.
 */
function Diff({
  entry,
  diff,
  bodyOpen,
  onBody,
}: {
  entry: PlanEntry;
  diff: FieldDiff[];
  bodyOpen: boolean;
  onBody: () => void;
}) {
  return (
    <div className="dsheet" role="region" aria-label={`Field by field, ${labelOf(entry)}`}>
      <div className="dr colhd" aria-hidden>
        <span>field</span>
        <span>now</span>
        <span />
        <span>would be</span>
      </div>
      {grouped(diff).map(({ group, rows }) => (
        <div key={group}>
          <div className="grp">{group}</div>
          {rows.map((row) =>
            row.settings?.length ? (
              <div key={row.field}>
                <div className="dr" data-c="unchanged">
                  <span className="k">{row.field}</span>
                  <span className="was text-mute">{row.before}</span>
                  <span className="arrow" />
                  <span className="now" />
                </div>
                {row.settings.map((s) => (
                  <div key={s.setting} className="dr" data-c={s.change}>
                    <span className="k sub">{s.setting}</span>
                    <span className="was">
                      <Value text={s.before} against={s.after} side="was" />
                    </span>
                    <Arrow />
                    <span className="now">
                      <Value text={s.after} against={s.before} side="now" />
                      {s.change === "reset" && <span className="tagr">reset</span>}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div key={row.field} className="dr" data-c={row.change}>
                <span className="k">{row.field}</span>
                <span className="was">
                  <Value text={row.before} against={row.after} side="was" />
                </span>
                <Arrow />
                <span className="now">
                  <Value text={row.after} against={row.before} side="now" />
                  {row.change === "reset" && <span className="tagr">reset</span>}
                  {row.body && row.body.changedLines > 0 && (
                    <button onClick={onBody} className="linkish ml-1.5">
                      {bodyOpen ? "hide the diff" : "show the diff"}
                    </button>
                  )}
                </span>
                {row.body && row.body.changedLines > 0 && bodyOpen && <Body unified={row.body.unified} />}
              </div>
            ),
          )}
        </div>
      ))}
    </div>
  );
}

/** The row's text, as an expander where there is a panel and as text where there is not. */
function Open({
  on,
  open,
  onOpen,
  children,
}: {
  on: boolean;
  open: boolean;
  onOpen: () => void;
  children: React.ReactNode;
}) {
  if (!on) return <span className="min-w-0 flex-1">{children}</span>;
  return (
    <button onClick={onOpen} aria-expanded={open} className="min-w-0 flex-1 text-left">
      {children}
    </button>
  );
}

const Arrow = () => (
  <span className="arrow" aria-hidden>
    <ChevronRight className="h-3 w-3" strokeWidth={2} />
  </span>
);

/**
 * One field's value.
 *
 * A list renders one item a line with a `+`/`−` gutter rather than as two
 * joined strings, because a team of four gaining a fifth is the commonest
 * overwrite in the feature and it should take one glance. `FieldDiff.before`
 * and `after` are strings, so a list is recognised by carrying a newline; a
 * single-line value draws as itself and nothing is guessed.
 */
function Value({ text, against, side }: { text: string; against: string; side: "was" | "now" }) {
  if (!text.includes("\n")) return <>{text}</>;
  const mine = text.split("\n");
  const theirs = new Set(against.split("\n"));
  return (
    <span className="items">
      {mine.map((item) => {
        const move = theirs.has(item) ? null : side === "now" ? "add" : "del";
        return (
          <span key={item} data-i={move ?? undefined}>
            <em aria-hidden>{move === "add" ? "+" : move === "del" ? "−" : ""}</em>
            {item}
          </span>
        );
      })}
    </span>
  );
}

/** The instructions, as the unified diff the Inspector already draws. */
function Body({ unified }: { unified: string }) {
  const lines = unified.split("\n").map((text) => {
    const kind = text.startsWith("@@") ? "hunk" : text.startsWith("+") ? "add" : text.startsWith("-") ? "del" : "ctx";
    return { kind, text: kind === "add" || kind === "del" ? text.slice(1) : text };
  });
  return (
    <div className="prose-diff">
      {lines.map(({ kind, text }, i) => (
        <div
          key={i}
          className={`ln ${
            kind === "add"
              ? "bg-sage-tint text-sage"
              : kind === "del"
                ? "bg-brick-tint text-brick"
                : kind === "hunk"
                  ? "text-slate"
                  : "text-dim"
          }`}
        >
          <span className="w-3 shrink-0 select-none opacity-60" aria-hidden>
            {kind === "add" ? "+" : kind === "del" ? "−" : " "}
          </span>
          <span className="flex-1 whitespace-pre">{text}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Files in the drop that were part of no profile.
 *
 * **Information, not a problem.** A folder somebody keeps profiles in holds a
 * `README.md` and a `.DS_Store`, and skipping those is correct behaviour — so
 * this spends no amber and no brick and does not compete with the rows that
 * need a decision. What it may never be is absent: a drop that quietly reads
 * three of five files is the failure this whole feature exists to remove.
 */
function Ignored({ paths }: { paths: string[] }) {
  const [open, setOpen] = useState(false);
  if (paths.length === 0) return null;
  return (
    <div className="note2">
      <span className="g">
        <FileText className="h-4 w-4" strokeWidth={1.75} />
      </span>
      <div>
        <p className="say">
          {paths.length === 1 ? "One file was not read." : `${paths.length} files were not read.`} A
          profile is a folder with a <span className="font-mono text-text">PROFILE.md</span> in it.
          <button onClick={() => setOpen(!open)} className="linkish">
            {open ? "hide them" : "show them"}
          </button>
        </p>
        {open && (
          <ul className="mt-2 flex flex-col gap-0.5 font-mono text-meta text-mute">
            {paths.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** A state is a pip and a word, never a badge: four badges read as four errors. */
function Pip({ kind, word, bare = false }: { kind: string; word?: string; bare?: boolean }) {
  if (bare) return <span className="pip" data-s={kind} />;
  return (
    <span className="outcome" data-s={kind}>
      <i />
      {word}
    </span>
  );
}
