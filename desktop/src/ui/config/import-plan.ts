/**
 * Reading an `ImportPlan`: what each entry would do, whether the drop can be
 * applied, and what the foot says when it cannot.
 *
 * **Nothing here re-derives what the plan already states.** The shape was
 * built so a client would not have to: `appliable` and `whyNot` are the
 * primary action's state and its explanation, `reset` is its own
 * [`FieldChange`] so nobody compares a value against a default, and `rename`
 * and `candidate` are outcomes rather than things to infer from a changed
 * `name`. Every function below either reads one of those or answers a question
 * about the *selection*, which is the one thing the server cannot know.
 *
 * Separated from the component because all of it is arithmetic over a value —
 * five outcomes, two answers, an exclusion set — and arithmetic that decides
 * whether a destructive button is available should be checkable without a
 * browser.
 */
import type {
  CandidateDecision,
  FieldDiff,
  ImportPlan,
  PlanEntry,
  PlanOutcome,
  PlanProblem,
} from "~/api/generated/model";

/** The five kinds, as the discriminant spells them. */
export type Kind = PlanOutcome["kind"];

/**
 * What somebody has done to the plan since it arrived.
 *
 * Both halves are the person's, not the server's: which entries they have
 * taken out, and what they answered about each candidate. A plan knows neither
 * and is never asked to.
 */
export type Selection = {
  /**
   * Entries the person has unticked, **by path**.
   *
   * The path is the entry's identity and the key is not: two bundles in one
   * archive can carry the same folder name, which is a blocking condition the
   * plan draws rather than prevents — and keyed by `key`, those two rows would
   * share one checkbox.
   */
  excluded: ReadonlySet<string>;
  /** Answers to candidates, by entry path. */
  answers: Readonly<Record<string, CandidateDecision>>;
};

export const UNTOUCHED: Selection = { excluded: new Set(), answers: {} };

/**
 * Whether the selection is still the one the plan was computed for.
 *
 * The gate on using `appliable` and `whyNot` verbatim. They are the truth
 * about *this* plan, and the moment somebody unticks a row they are the truth
 * about a drop nobody is looking at any more — a plan that says "Security
 * Advisor is blocked, exclude it to import the other 4" is wrong the instant
 * you do. So the server's own sentences are shown while they hold, and the
 * derivation below takes over after that.
 *
 * The alternative — always re-deriving — throws away wording the server is
 * better placed to write, since it is the side that knows *why* a name did not
 * resolve. The other alternative, always trusting `appliable`, leaves the
 * primary disabled after the person has done exactly what the sentence asked.
 */
export const untouched = (sel: Selection): boolean =>
  sel.excluded.size === 0 && Object.keys(sel.answers).length === 0;

export const included = (sel: Selection, entry: PlanEntry): boolean => !sel.excluded.has(entry.path);

/**
 * What an entry would do, after the person's answer.
 *
 * Only a candidate moves. Answering *same profile* makes it the overwrite it
 * would have been had the key matched — a rename when the file's `name` is not
 * the row's, because that is the one the review has to say out loud. Answering
 * *a new profile* makes it a create.
 *
 * The answer does not bring a diff with it: a `PlanProposal` carries the
 * profile, not the sixteen fields it would become, so the fields arrive on the
 * next plan (#358 re-plans with the answer in `ProfileDrop.answers`). Until
 * then an answered row states its consequence in words rather than drawing a
 * diff it does not have, which is better than drawing a guess.
 */
export function outcomeOf(entry: PlanEntry, sel: Selection): Kind {
  if (entry.outcome.kind !== "candidate") return entry.outcome.kind;
  const answer = sel.answers[entry.path];
  if (!answer) return "candidate";
  if (answer.kind === "newProfile") return "new";
  const to = entry.outcome.proposals.find((p) => p.profile.id === answer.profile);
  return to && entry.name && to.profile.name !== entry.name ? "rename" : "overwrite";
}

/** The profile an answered *same profile* would write onto. */
export function answeredTarget(entry: PlanEntry, sel: Selection) {
  if (entry.outcome.kind !== "candidate") return null;
  const answer = sel.answers[entry.path];
  if (!answer || answer.kind === "newProfile") return null;
  return entry.outcome.proposals.find((p) => p.profile.id === answer.profile)?.profile ?? null;
}

/**
 * The buckets the filter pills narrow to.
 *
 * A rename is an overwrite: it writes the same row, and sorting it elsewhere
 * would put a profile under *New* that is not being created. An unanswered
 * candidate is its own bucket because it is the only one holding up the
 * import that is not an error.
 */
export type Bucket = "blocked" | "candidate" | "overwrite" | "new";
export const bucketOf = (kind: Kind): Bucket =>
  kind === "blocked" || kind === "candidate" ? kind : kind === "new" ? "new" : "overwrite";

/**
 * How many entries there are of each kind, and how the selection splits them.
 *
 * `blocked` and `unanswered` count the **included** ones only: an excluded
 * blocked profile is not holding anything up, which is the whole reason
 * excluding is offered.
 */
export function tally(plan: ImportPlan, sel: Selection) {
  const t = {
    all: plan.entries.length,
    blocked: 0,
    candidate: 0,
    overwrite: 0,
    new: 0,
    in: 0,
    out: 0,
    /** Included and blocked. */
    blocking: 0,
    /** Included and still unanswered. */
    unanswered: 0,
  };
  for (const entry of plan.entries) {
    const kind = outcomeOf(entry, sel);
    t[bucketOf(kind)]++;
    if (included(sel, entry)) {
      t.in++;
      if (kind === "blocked") t.blocking++;
      if (kind === "candidate") t.unanswered++;
    } else t.out++;
  }
  return t;
}

/** Every included entry's name, for a sentence that has to name one. */
const firstBlocked = (plan: ImportPlan, sel: Selection): PlanEntry | undefined =>
  plan.entries.find((e) => included(sel, e) && outcomeOf(e, sel) === "blocked");

/**
 * What an entry is called on screen.
 *
 * The `name` the file gives, the folder it came from, and then the path —
 * because a `PROFILE.md` dropped **without its folder** has neither of the
 * first two. Its key is the empty string, and a file that never parsed has no
 * name either, so the obvious two-step fallback drew a row with no title at
 * all. The path is always there: it is the entry's identity.
 */
export const labelOf = (entry: PlanEntry): string => entry.name || entry.key || entry.path;

/**
 * The bounds an import takes, in the words of the thing being bounded.
 *
 * Read off `plan.limits` rather than written here. The figures in a refusal
 * are the server's — this is the same sentence from the other side, so that
 * somebody who has hit one bound can see the rest without hitting them too.
 */
export function bounds(limits: ImportPlan["limits"]): string {
  const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;
  const kb = (n: number) => `${Math.round(n / 1024)} KB`;
  return `At most ${limits.files} files, ${kb(limits.fileBytes)} a file, ${mb(
    limits.totalBytes,
  )} in total, and ${limits.depth} folders deep.`;
}

/**
 * The diagnosis, for a banner heading that can be acted on in a scan.
 *
 * The first sentence of the first problem: the server writes `says` as a
 * condition followed by what to do about it, so the condition is the half a
 * heading wants and the remainder belongs beside the line it is about.
 *
 * Cut here rather than asked for, because `PlanProblem` has no field for it.
 * The alternative is a heading reading "Designer is blocked", which repeats
 * the word the pip already carries and says nothing about *what* is wrong —
 * the failure this screen's copy pass fixed once already.
 */
export function conditionOf(entry: PlanEntry): string | null {
  if (entry.outcome.kind !== "blocked") return null;
  const first = entry.outcome.problems[0];
  if (!first) return null;
  const stop = first.says.indexOf(". ");
  return stop === -1 ? first.says.replace(/\.$/, "") : first.says.slice(0, stop);
}

/**
 * Whether a warning is the one amber is allowed to be spent on.
 *
 * **Amber means one thing here: a name that may be a duplicate.** It is spent
 * on a reset in the diff and on this, and on nothing else — so a warning takes
 * it by passing a test rather than by being a warning. The alternative, which
 * shipped first, was to colour `warnings` amber wholesale; that is right only
 * for as long as the server emits one kind of warning, and it over-spends the
 * screen's one remaining signal the moment it emits a second.
 */
export const aboutADuplicateName = (w: PlanProblem): boolean => w.key === "name";

/**
 * Whether the primary action is available, and why it is not.
 *
 * `reasons` are whole sentences. While the plan is untouched they are the
 * server's own; after that they are derived, because the server's were written
 * about a selection that no longer exists.
 */
export function appliability(plan: ImportPlan, sel: Selection): { appliable: boolean; reasons: string[] } {
  /* **A dead primary never appears without a sentence.** A drop holding no
     bundle at all comes back unappliable with nothing in `whyNot`, and a
     disabled button beside an empty explanation is this product's oldest
     failure wearing a new hat: something was accepted and nothing happened,
     with no way to find out why. The server's reason is better than this one
     and is being added; until then the screen still answers the question. */
  if (plan.entries.length === 0)
    return {
      appliable: false,
      reasons: plan.whyNot.length
        ? plan.whyNot
        : ["Nothing in that folder is a profile. A profile is a folder with a PROFILE.md in it."],
    };
  if (untouched(sel)) return { appliable: plan.appliable, reasons: plan.whyNot };

  const t = tally(plan, sel);
  const reasons: string[] = [];
  if (t.in === 0)
    reasons.push(
      t.out === 1
        ? "The one profile in this drop is excluded."
        : `All ${t.out} profiles in this drop are excluded.`,
    );
  if (t.blocking > 0) {
    const one = firstBlocked(plan, sel);
    reasons.push(
      t.blocking === 1 && one
        ? `${labelOf(one)} is blocked.`
        : `${t.blocking} profiles are blocked.`,
    );
  }
  if (t.unanswered > 0)
    reasons.push(
      t.unanswered === 1
        ? "One profile is waiting on an answer."
        : `${t.unanswered} profiles are waiting on an answer.`,
    );
  return { appliable: reasons.length === 0, reasons };
}

/**
 * The sticky foot's sentence: **what makes the button work again.**
 *
 * A different job from the banner, which says what is wrong. This one is about
 * the control beside it, so it is always derived — it has to count exclusions,
 * and the excluded count is the one number that may never leave the foot.
 *
 * `lead` is the clause worth reading first and is drawn bold; `rest` is what to
 * do about it. The primary keeps its real label either way: a button that
 * relabels itself to "Can't import" has thrown away what it would do in order
 * to repeat the sentence next to it.
 */
export type Foot = {
  tone: "bad" | "warn" | "plain";
  lead: string;
  rest: string;
  /** Said after the sentence, in the faintest tier, whenever it is not zero. */
  excluded: number;
};

export function foot(plan: ImportPlan, sel: Selection): Foot {
  /* Same defence as `appliability`: the foot is the sentence beside the
     button, so it is the one that may never be blank while the button is. */
  if (plan.entries.length === 0) {
    const [lead, ...rest] = appliability(plan, sel).reasons;
    return { tone: "bad", lead: lead ?? "", rest: rest.join(" "), excluded: 0 };
  }

  const t = tally(plan, sel);
  const excluded = t.out;

  if (t.blocking > 0) {
    const one = t.blocking === 1 ? firstBlocked(plan, sel) : undefined;
    const rest = t.in - t.blocking;
    const its = one ? "its file" : "their files";
    return {
      tone: "bad",
      lead: one ? `${labelOf(one)} is blocked.` : `${t.blocking} profiles are blocked.`,
      rest:
        rest === 0
          ? `Fix ${its} and drop the folder again.`
          : `Fix ${its}, or exclude ${one ? "it" : "them"} to import the other ${rest}.`,
      excluded,
    };
  }

  /* **Not a severity.** The primary is unavailable, which is what the
     disabled button says, but nobody's file is wrong — the screen is waiting
     on a person. Brick here would draw a refusal over a question, and amber is
     spent on a reset and on a name that may be a duplicate. */
  if (t.unanswered > 0)
    return {
      tone: "plain",
      lead: t.unanswered === 1 ? "One profile needs an answer." : `${t.unanswered} profiles need an answer.`,
      rest: "Say whether each file is a profile you already have, or a new one.",
      excluded,
    };

  if (t.in === 0)
    return {
      tone: "bad",
      lead: "Nothing left to import.",
      rest: t.out === 1 ? "The one profile in this drop is excluded." : `All ${t.out} are excluded.`,
      excluded: 0,
    };

  const back = resets(plan, sel);
  if (back.length > 0)
    return {
      tone: "warn",
      lead: back.length === 1 ? "One field" : `${back.length} fields`,
      rest: `would go back to ${back.length === 1 ? "its default" : "their defaults"}, named in the diff above.`,
      excluded,
    };

  /* The one thing about pressing it that is nowhere else on the screen. The
     second sentence is the profile editor's own foot, word for word. */
  return {
    tone: "plain",
    lead: "",
    rest: "Written when you press it. Running workspaces keep the profile they started with.",
    excluded,
  };
}

/* ── The diff ─────────────────────────────────────────────────────────── */

/**
 * The sixteen fields, grouped the way the exporter writes them.
 *
 * So the diff reads in the order of the thing being diffed and a reviewer can
 * put a row beside a line in the file without translating.
 */
export const FIELD_GROUPS: { group: string; fields: string[] }[] = [
  { group: "Identity", fields: ["name", "does", "instructions"] },
  {
    group: "Where and how its children run",
    fields: ["engine", "placement", "machine", "account", "directory"],
  },
  { group: "Delegation", fields: ["can_delegate", "delegates_to"] },
  { group: "Skills", fields: ["skills", "include_always_on", "include_repo_defaults"] },
  { group: "When a child runs out of allowance", fields: ["on_usage_limit", "on_child_limit"] },
  { group: "How it runs its agent", fields: ["settings"] },
];

/** How many fields a profile has. Asserted against the table, not trusted. */
export const FIELD_COUNT = FIELD_GROUPS.reduce((n, g) => n + g.fields.length, 0);

/**
 * The diff in the table's order, grouped.
 *
 * **A field this version has never heard of is still drawn**, in a group of its
 * own at the end. The screen exists so that nothing is written unseen, and a
 * client one release behind its server silently dropping a row would be that
 * failure with a version number attached.
 */
export function grouped(diff: FieldDiff[]): { group: string; rows: FieldDiff[] }[] {
  const left = new Map(diff.map((d) => [d.field, d]));
  const out = FIELD_GROUPS.map(({ group, fields }) => {
    const rows: FieldDiff[] = [];
    for (const field of fields) {
      const row = left.get(field);
      if (row) {
        rows.push(row);
        left.delete(field);
      }
    }
    return { group, rows };
  }).filter((g) => g.rows.length > 0);
  if (left.size > 0) out.push({ group: "Other fields", rows: [...left.values()] });
  return out;
}

/** One field that moved, named the way the summary line names it. */
export type Moved = { field: string; reset: boolean };

/**
 * Every field that moved, in file order, each `settings` leaf on its own.
 *
 * Named rather than counted, so the disclosure is never load-bearing: a row
 * reading "2 changes" makes expanding it the only way to find out what they
 * were, on the one screen whose job is that nothing is missed.
 */
export function moved(diff: FieldDiff[]): Moved[] {
  const out: Moved[] = [];
  for (const d of diff) {
    if (d.settings?.length) {
      for (const s of d.settings)
        if (s.change !== "unchanged")
          out.push({ field: `${d.field}.${s.setting}`, reset: s.change === "reset" });
      continue;
    }
    if (d.change !== "unchanged") out.push({ field: d.field, reset: d.change === "reset" });
  }
  return out;
}

/** The fields that did not move, counted at the top level the way the file reads. */
export function unchanged(diff: FieldDiff[]): number {
  const touched = new Set(moved(diff).map((m) => m.field.split(".")[0]!));
  return FIELD_COUNT - touched.size;
}

/** The diff an outcome carries, when it carries one. */
export function diffOf(entry: PlanEntry): FieldDiff[] | null {
  const o = entry.outcome;
  return o.kind === "overwrite" || o.kind === "rename" ? o.diff : null;
}

/**
 * Every reset in the included part of the drop, as profile and field.
 *
 * The one genuinely surprising thing the feature does, so it is counted across
 * the whole drop and said in the banner and the foot as well as in the row.
 */
export function resets(plan: ImportPlan, sel: Selection): { profile: string; field: string }[] {
  const out: { profile: string; field: string }[] = [];
  for (const entry of plan.entries) {
    if (!included(sel, entry) || outcomeOf(entry, sel) === "blocked") continue;
    const diff = diffOf(entry);
    if (!diff) continue;
    for (const m of moved(diff)) if (m.reset) out.push({ profile: labelOf(entry), field: m.field });
  }
  return out;
}

/**
 * Rows that arrive expanded: the two things that can surprise you are never
 * behind a disclosure.
 *
 * A blocked profile, because its reasons are the only thing on the row worth
 * reading, and a row carrying a reset, because a setting going back to a
 * default is the one change nobody asked for. A drop of one opens too, the way
 * `AddSkill` opens a single bundle.
 */
export function openOnArrival(plan: ImportPlan): Set<string> {
  const open = new Set<string>();
  for (const entry of plan.entries) {
    if (entry.outcome.kind === "blocked" || plan.entries.length === 1) {
      open.add(entry.path);
      continue;
    }
    const diff = diffOf(entry);
    if (diff && moved(diff).some((m) => m.reset)) open.add(entry.path);
  }
  return open;
}

/** Past this many entries a flat list stops being scannable and gains pills. */
export const FILTER_AT = 12;

/**
 * Wording a blocked reason may not use about a resource somebody cannot see.
 *
 * From the threat model (`profiles-as-code-threat-model`): a plan that
 * distinguishes *hidden* from *nonexistent* is an enumeration oracle for
 * machines, subscriptions, directories and other people's profiles, and the
 * drop is a machine-readable one. So the two read identically — "not available
 * to you" — and the sentence earns its keep by naming what to do instead,
 * rather than by confirming what exists.
 *
 * Exported so the test can hold every specimen plan to it. The sentences
 * themselves are the server's (#358); this is the client-side half of the
 * criterion, and what stops a fixture drifting back.
 */
export const ORACLE_PHRASES: RegExp[] = [
  /\bis not here\b/i,
  /\bare not here\b/i,
  /\bdoes ?n[o']t exist\b/i,
  /\bdoes not exist\b/i,
  /\bno such\b/i,
  /\bno (machine|subscription|directory|profile|teammate|account)\b[^.]*\bhere\b/i,
  /\bunknown (machine|subscription|directory|profile|teammate|account)\b/i,
  /\bnever existed\b/i,
];

/** Every phrase above that a sentence breaks. Empty is the passing answer. */
export const oracleWording = (says: string): string[] =>
  ORACLE_PHRASES.filter((re) => re.test(says)).map(String);

/* ── The heading and the line under it ────────────────────────────────── */

/** How many were found, which is the first thing to know. */
export function heading(plan: ImportPlan): string {
  const n = plan.entries.length;
  if (n === 0) return "Nothing in this drop is a profile";
  return n === 1 ? "One profile found" : `${n} profiles found`;
}

/** `a, b and c` — the serial comma left off, which is how the product writes. */
const series = (parts: string[]): string =>
  parts.length <= 1
    ? (parts[0] ?? "")
    : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

/**
 * What is in the drop, as counts.
 *
 * **Composition, never advice.** The banner says what is wrong and the foot
 * says what to do about it; this line exists so somebody can see at a glance
 * whether the drop is the one they meant. A drop that is all one thing says so
 * in words instead of counting to itself.
 */
export function composition(plan: ImportPlan, sel: Selection): string {
  const t = tally(plan, sel);
  if (t.all === 0) return "";
  if (t.new === t.all) return "None of them exists here yet.";
  if (t.overwrite === t.all)
    return t.all === 1
      ? "It would replace a profile already here."
      : "Each one would replace a profile already here.";
  if (t.blocked === t.all)
    return t.all === 1 ? "It cannot be imported as it is." : "None of them can be imported as they are.";

  const parts: string[] = [];
  if (t.blocked > 0) parts.push(`${t.blocked} ${t.blocked === 1 ? "is" : "are"} blocked`);
  if (t.candidate > 0)
    parts.push(`${t.candidate} ${t.candidate === 1 ? "is" : "are"} waiting on an answer`);
  if (t.overwrite > 0) parts.push(`${t.overwrite} would replace a profile already here`);
  if (t.new > 0) parts.push(`${t.new} would be created`);
  const said = series(parts);
  return `${said.charAt(0).toUpperCase()}${said.slice(1)}.`;
}

/** The state word beside an entry's pip. Never colour alone. */
export function stateWord(entry: PlanEntry, sel: Selection): string {
  const kind = outcomeOf(entry, sel);
  if (kind === "blocked") return "blocked";
  if (kind === "candidate") return "waiting on an answer";
  if (kind === "new") return "will be created";
  if (kind === "rename") return "will rename";
  const diff = diffOf(entry);
  return diff && moved(diff).length === 0 ? "nothing would change" : "will overwrite";
}

/**
 * Which pip an entry wears.
 *
 * Four hues, each already meaning this elsewhere in the product: brick for a
 * refusal, slate for an overwrite, sage for a create. An unanswered candidate
 * takes **no hue at all** — it is a control rather than a finding, and amber is
 * spent on exactly two things. It reads as a hollow ring and its word.
 */
export type Pip = "blocked" | "overwrite" | "new" | "nochange" | "asking";
export function pipOf(entry: PlanEntry, sel: Selection): Pip {
  const kind = outcomeOf(entry, sel);
  if (kind === "blocked") return "blocked";
  if (kind === "candidate") return "asking";
  if (kind === "new") return "new";
  if (kind === "rename") return "overwrite";
  const diff = diffOf(entry);
  return diff && moved(diff).length === 0 ? "nochange" : "overwrite";
}
