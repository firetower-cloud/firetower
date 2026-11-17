/**
 * Reading a plan: the arithmetic that decides whether a destructive button is
 * available, and the discipline the sentences and the colours are held to.
 *
 * **The specimens are the planner's own output.** `import-plans.json` is
 * written by `crates/ft-server/src/roles/import.rs`'s `specimens` tests from
 * the real `plan()`, so every string asserted below is one the product prints.
 * The first version of this file asserted against hand-written fixtures and
 * every one of their sentences was invented — well-edited, plausible, and
 * never produced by anything. That is why the fixture is generated now and why
 * two of the tests here are about *words* rather than about shape.
 */
import { describe, expect, it } from "vitest";
import type { ImportPlan, PlanEntry } from "~/api/generated/model";
import {
  FIELD_COUNT,
  bounds,
  labelOf,
  FIELD_GROUPS,
  UNTOUCHED,
  aboutADuplicateName,
  appliability,
  bucketOf,
  composition,
  conditionOf,
  diffOf,
  foot,
  grouped,
  moved,
  openOnArrival,
  oracleWording,
  outcomeOf,
  pipOf,
  resets,
  stateWord,
  tally,
  unchanged,
} from "./import-plan";
import { PLANS, REFUSALS } from "./import-plans";

const ALL_NEW = PLANS["all-new"]!;
const MIXED = PLANS.mixed!;
const ALL_BLOCKED = PLANS["all-blocked"]!;
const RENAME = PLANS.rename!;
const NEAR_MATCH = PLANS["near-match"]!;
const LARGE = PLANS.large!;
const SAME_NAME = PLANS["same-name"]!;
const SAME_KEY = PLANS["same-key"]!;
const AT_THE_ROOT = PLANS["at-the-root"]!;

const sel = (excluded: string[] = [], answers = {}) => ({ excluded: new Set(excluded), answers });
const entry = (plan: ImportPlan, key: string): PlanEntry => plan.entries.find((e) => e.key === key)!;
const at = (plan: ImportPlan, key: string) => entry(plan, key).path;

/** An empty drop: unappliable, and the server has no reason for it yet. */
const EMPTY: ImportPlan = { appliable: false, whyNot: [], entries: [], ignored: [], limits: MIXED.limits };

describe("whether the import can go ahead", () => {
  it("is the plan's own answer while nobody has touched it", () => {
    expect(appliability(MIXED, UNTOUCHED)).toEqual({ appliable: false, reasons: MIXED.whyNot });
    expect(appliability(ALL_NEW, UNTOUCHED)).toEqual({ appliable: true, reasons: [] });
  });

  /* The plan's sentence offers leaving a bundle out. Doing that has to work,
     which means the server's verdict cannot survive it. */
  it("re-derives once something has been excluded", () => {
    const after = appliability(MIXED, sel([at(MIXED, "security-advisor")]));
    expect(after.appliable).toBe(false); // the candidate is still unanswered
    expect(after.reasons).toEqual(["One profile is waiting on an answer."]);

    const both = appliability(MIXED, sel([at(MIXED, "security-advisor"), at(MIXED, "qa-engineer")]));
    expect(both).toEqual({ appliable: true, reasons: [] });
  });

  it("is held up by an unanswered candidate, and freed by answering one", () => {
    expect(appliability(NEAR_MATCH, UNTOUCHED).appliable).toBe(false);
    const answered = sel([], { [at(NEAR_MATCH, "designer")]: { kind: "newProfile" } as const });
    expect(appliability(NEAR_MATCH, answered)).toEqual({ appliable: true, reasons: [] });
  });

  it("says so when everything has been excluded", () => {
    const none = appliability(ALL_NEW, sel(ALL_NEW.entries.map((e) => e.path)));
    expect(none.appliable).toBe(false);
    expect(none.reasons).toEqual(["All 5 profiles in this drop are excluded."]);
  });

  /* #349 in a new place: something was accepted, nothing happened, and the
     screen had no answer. A dead primary always has a sentence beside it. */
  it("never leaves an empty drop without a reason", () => {
    const { appliable, reasons } = appliability(EMPTY, UNTOUCHED);
    expect(appliable).toBe(false);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/PROFILE\.md/);
    expect(foot(EMPTY, UNTOUCHED).lead).not.toBe("");
  });

  it("prefers the server's reason for an empty drop when it has one", () => {
    const said = { ...EMPTY, whyNot: ["Nothing in that folder looks like a profile."] };
    expect(appliability(said, UNTOUCHED).reasons).toEqual(said.whyNot);
  });
});

describe("the foot: what makes the button work again", () => {
  it("names the one blocked profile and what is left without it", () => {
    expect(foot(MIXED, UNTOUCHED)).toEqual({
      tone: "bad",
      lead: "Security Advisor is blocked.",
      rest: "Fix its file, or exclude it to import the other 4.",
      excluded: 0,
    });
  });

  it("does not offer exclusion when excluding leaves nothing", () => {
    expect(foot(ALL_BLOCKED, UNTOUCHED).rest).toBe("Fix their files and drop the folder again.");
  });

  it("keeps the excluded count beside the primary", () => {
    expect(foot(MIXED, sel([at(MIXED, "security-advisor")])).excluded).toBe(1);
    expect(foot(ALL_NEW, sel([at(ALL_NEW, "qa"), at(ALL_NEW, "designer")])).excluded).toBe(2);
  });

  it("warns, rather than refusing, when a field would go back to its default", () => {
    const f = foot(MIXED, sel([at(MIXED, "security-advisor"), at(MIXED, "qa-engineer")]));
    expect(f.tone).toBe("warn");
    expect(`${f.lead} ${f.rest}`).toMatch(/would go back to/);
  });

  /* Nobody's file is wrong — the screen is waiting on a person. Brick would
     draw a refusal over a question. */
  it("asks for no severity while a candidate is unanswered", () => {
    expect(foot(NEAR_MATCH, UNTOUCHED).tone).toBe("plain");
  });

  it("falls back to the one fact that is nowhere else on the screen", () => {
    expect(foot(ALL_NEW, UNTOUCHED)).toEqual({
      tone: "plain",
      lead: "",
      rest: "Written when you press it. Running workspaces keep the profile they started with.",
      excluded: 0,
    });
  });
});

describe("the banner's diagnosis", () => {
  /* The heading has to say *what* is wrong, not the word the pip already
     carries. "Designer is blocked" over a body reading "one bundle is
     blocked" is the repetition the copy pass removed once already. */
  it("is the condition, taken from the first problem's first sentence", () => {
    const said = conditionOf(entry(MIXED, "security-advisor"))!;
    expect(said).toBe("no machine named `mac-studio` is available to you");
    expect(said).not.toMatch(/blocked/);
    // And it is a prefix of what the row says, not a paraphrase of it.
    const problems = entry(MIXED, "security-advisor").outcome;
    expect(problems.kind === "blocked" && problems.problems[0]!.says.startsWith(said)).toBe(true);
  });

  it("is nothing for an entry that is not blocked", () => {
    expect(conditionOf(entry(MIXED, "designer"))).toBeNull();
  });

  /* The bound catches a `says` with no sentence break in it at all, where the
     heading would become the whole paragraph. It is not there to police the
     server's sentence length — the longest real one is 100 characters and
     earns it, because the clause nobody can cut says the name is not in the
     drop either. */
  it.each(
    Object.entries(PLANS).flatMap(([name, plan]) =>
      plan.entries
        .filter((e) => e.outcome.kind === "blocked")
        .map((e) => [`${name}/${e.key}`, e] as const),
    ),
  )("%s has a heading short enough to scan", (_where, e) => {
    const said = conditionOf(e)!;
    expect(said.length).toBeGreaterThan(8);
    expect(said.length).toBeLessThanOrEqual(110);
  });
});

describe("what an entry would do", () => {
  it("leaves every outcome but a candidate alone", () => {
    expect(outcomeOf(entry(MIXED, "designer"), UNTOUCHED)).toBe("overwrite");
    expect(outcomeOf(entry(MIXED, "security-advisor"), UNTOUCHED)).toBe("blocked");
    expect(outcomeOf(entry(RENAME, "designer"), UNTOUCHED)).toBe("rename");
    expect(outcomeOf(entry(ALL_NEW, "qa"), UNTOUCHED)).toBe("new");
  });

  it("moves a candidate to the branch that was chosen", () => {
    const one = entry(NEAR_MATCH, "designer");
    expect(outcomeOf(one, UNTOUCHED)).toBe("candidate");
    expect(outcomeOf(one, sel([], { [one.path]: { kind: "newProfile" } }))).toBe("new");
    /* The file calls it `designer`, the row is `Designer`, so saying they are
       the same profile is a rename — the word the review has to say. */
    const to = one.outcome.kind === "candidate" ? one.outcome.proposals[0]!.profile.id : "";
    expect(outcomeOf(one, sel([], { [one.path]: { kind: "sameProfile", profile: to } }))).toBe("rename");
  });

  it("gives a rename its own word and an overwrite's pip", () => {
    expect(stateWord(entry(RENAME, "designer"), UNTOUCHED)).toBe("will rename");
    expect(pipOf(entry(RENAME, "designer"), UNTOUCHED)).toBe("overwrite");
    expect(bucketOf("rename")).toBe("overwrite");
  });

  it("says when nothing would change, and keeps the row importable", () => {
    const same = entry(MIXED, "engineer");
    expect(stateWord(same, UNTOUCHED)).toBe("nothing would change");
    expect(pipOf(same, UNTOUCHED)).toBe("nochange");
  });

  it("gives an unanswered candidate no hue", () => {
    expect(pipOf(entry(NEAR_MATCH, "designer"), UNTOUCHED)).toBe("asking");
  });

  /* Two bundles in one archive can carry one folder name. Keyed by `key`
     rather than by `path`, those two rows would share one checkbox. */
  it("tells two bundles of the same key apart by their paths", () => {
    const [a, b] = SAME_KEY.entries;
    expect(a!.key).toBe(b!.key);
    expect(a!.path).not.toBe(b!.path);
    const one = sel([a!.path]);
    expect(SAME_KEY.entries.filter((e) => !one.excluded.has(e.path))).toHaveLength(1);
  });
});

describe("what a row calls itself", () => {
  it("uses the name the file gives", () => {
    expect(labelOf(entry(MIXED, "designer"))).toBe("Designer");
  });

  it("falls back to the folder when the file gave no name", () => {
    const nameless = ALL_BLOCKED.entries.find((e) => e.name == null)!;
    expect(labelOf(nameless)).toBe(nameless.key);
  });

  /* A `PROFILE.md` dropped without its folder has no key *and* no name, which
     drew a row with no title at all. Every entry has a path. */
  it("falls back to the path when there is neither", () => {
    const root = AT_THE_ROOT.entries[0]!;
    expect(root.key).toBe("");
    expect(root.name ?? null).toBeNull();
    expect(labelOf(root)).toBe("PROFILE.md");
  });

  it("never draws a row with no title, in any specimen", () => {
    for (const [name, plan] of Object.entries(PLANS))
      for (const e of plan.entries)
        expect([`${name}/${e.path}`, labelOf(e).trim().length > 0]).toEqual([
          `${name}/${e.path}`,
          true,
        ]);
  });
});

describe("the bounds an import takes", () => {
  /* Read off `plan.limits` rather than written beside the screen — the same
     lesson the fixtures taught, applied to the one number the client had been
     about to hard-code. */
  it("comes from the plan, and says every bound", () => {
    const said = bounds(MIXED.limits);
    expect(said).toContain(`${MIXED.limits.files} files`);
    expect(said).toContain(`${Math.round(MIXED.limits.fileBytes / 1024)} KB`);
    expect(said).toContain(`${Math.round(MIXED.limits.totalBytes / 1024 / 1024)} MB`);
    expect(said).toContain(`${MIXED.limits.depth} folders deep`);
  });

  it("moves when the plan's limits move", () => {
    const tighter = { ...MIXED.limits, files: 12 };
    expect(bounds(tighter)).toContain("12 files");
    expect(bounds(tighter)).not.toContain(`${MIXED.limits.files} files`);
  });
});

describe("the diff", () => {
  it("has sixteen fields and six groups", () => {
    expect(FIELD_COUNT).toBe(16);
    const diff = diffOf(entry(MIXED, "designer"))!;
    expect(diff).toHaveLength(16);
    expect(grouped(diff).flatMap((g) => g.rows)).toHaveLength(16);
  });

  /* The screen's grouping has to cover what the planner actually emits. A
     field landing in "Other fields" would be a real row drawn as an oddity. */
  it("groups every field the planner emits, with none left over", () => {
    const known = new Set(FIELD_GROUPS.flatMap((g) => g.fields));
    for (const plan of Object.values(PLANS))
      for (const e of plan.entries) {
        const diff = diffOf(e);
        if (!diff) continue;
        for (const row of diff) expect([row.field, known.has(row.field)]).toEqual([row.field, true]);
      }
  });

  it("draws a field it has never heard of rather than dropping it", () => {
    const diff = diffOf(entry(MIXED, "designer"))!;
    const extra = [...diff, { field: "mood", before: "calm", after: "brisk", change: "changed" as const }];
    const groups = grouped(extra);
    expect(groups[groups.length - 1]!.group).toBe("Other fields");
  });

  it("names what moved, and counts what did not", () => {
    const diff = diffOf(entry(MIXED, "designer"))!;
    const names = moved(diff).map((m) => m.field);
    expect(names).toContain("instructions");
    expect(names).toContain("settings.model");
    expect(moved(diff).find((m) => m.field === "settings.model")!.reset).toBe(true);
    expect(unchanged(diff)).toBeLessThan(FIELD_COUNT);
  });

  it("collects every reset in the included part of the drop", () => {
    expect(resets(MIXED, UNTOUCHED).length).toBeGreaterThan(0);
    expect(resets(MIXED, sel([at(MIXED, "designer")]))).toEqual([]);
  });
});

describe("what arrives expanded", () => {
  it("opens a blocked row and a row carrying a reset, and nothing else", () => {
    expect([...openOnArrival(MIXED)].sort()).toEqual(
      [at(MIXED, "designer"), at(MIXED, "security-advisor")].sort(),
    );
    expect([...openOnArrival(ALL_NEW)]).toEqual([]);
  });

  it("opens a drop of one, the way AddSkill opens a single bundle", () => {
    expect([...openOnArrival(RENAME)]).toEqual([at(RENAME, "designer")]);
  });
});

describe("the line under the heading", () => {
  it("says what is in the drop rather than what to do about it", () => {
    expect(composition(ALL_NEW, UNTOUCHED)).toBe("None of them exists here yet.");
    expect(composition(ALL_BLOCKED, UNTOUCHED)).toBe("None of them can be imported as they are.");
    expect(composition(MIXED, UNTOUCHED)).toBe(
      "1 is blocked, 1 is waiting on an answer and 3 would replace a profile already here.",
    );
  });
});

describe("the list", () => {
  it("counts a large drop into its buckets", () => {
    const t = tally(LARGE, UNTOUCHED);
    expect(t.all).toBe(23);
    expect(t.blocked + t.overwrite + t.new + t.candidate).toBe(23);
    expect(t.blocked).toBeGreaterThan(0);
  });

  /* "In path order", which the type promises and the screen may never
     re-sort: somebody checking a folder they know has to find a name where
     they expect it, and sorting by severity would move it. */
  it("is in path order, and never in state order", () => {
    const paths = LARGE.entries.map((e) => e.path);
    expect(paths).toHaveLength(23);
    expect(paths).toEqual([...paths].sort());

    const states = LARGE.entries.map((e) => e.outcome.kind);
    expect(states).not.toEqual([...states].sort());
  });
});

/* ── The sentences ─────────────────────────────────────────────────────── */

const everySentence = Object.entries(PLANS).flatMap(([name, plan]) => [
  ...plan.whyNot.map((s) => [`${name}.whyNot`, s] as const),
  ...plan.entries.flatMap((e) => [
    ...(e.outcome.kind === "blocked"
      ? e.outcome.problems.map((p) => [`${name}/${e.key} ${p.key ?? "file"}`, p.says] as const)
      : []),
    ...(e.outcome.kind === "candidate"
      ? e.outcome.proposals.map((p) => [`${name}/${e.key} proposal`, p.says] as const)
      : []),
    ...e.warnings.map((w) => [`${name}/${e.key} warning`, w.says] as const),
  ]),
]);

describe("a blocked reason may not say whether something exists", () => {
  /* From the threat model: a plan that tells a hidden resource apart from an
     absent one is an enumeration oracle, and a drop is machine-readable. */
  it("has sentences to check", () => {
    expect(everySentence.length).toBeGreaterThan(20);
  });

  it.each(everySentence)("%s reads the same hidden or absent", (_where, says) => {
    expect(oracleWording(says)).toEqual([]);
  });

  it("uses the available-to-you wording on all four nouns", () => {
    const said = everySentence.map(([, s]) => s).join(" ");
    for (const noun of ["machine", "subscription", "directory", "profile"])
      expect(said).toMatch(new RegExp(`no ${noun} named [^.]*is available to you`));
  });
});

describe("colour discipline", () => {
  /* The accepted rule: amber means *read before you accept*, and it is spent
     on exactly two things — a reset, and a name that may be a duplicate.
     Colouring `warnings` wholesale is right only while the server emits one
     kind of warning, so the rule is a predicate rather than a coincidence. */
  it("spends amber on a duplicate name and on nothing else", () => {
    const warnings = Object.values(PLANS).flatMap((p) => p.entries.flatMap((e) => e.warnings));
    expect(warnings.length).toBeGreaterThan(0);
    for (const w of warnings)
      expect([w.says, aboutADuplicateName(w)]).toEqual([w.says, /is also called/.test(w.says)]);
  });

  it("marks the duplicate-name warning the specification calls the one warn row", () => {
    const both = SAME_NAME.entries.flatMap((e) => e.warnings);
    expect(both).toHaveLength(2);
    expect(both.every(aboutADuplicateName)).toBe(true);
    // It warns rather than blocking: both rows are still importable.
    expect(SAME_NAME.appliable).toBe(true);
  });
});

describe("a drop past a bound", () => {
  /* Not a plan: `plan()` returns `Refused` and the API makes it an
     `InvalidRequest`, so there is no `ImportPlan` with no entries and a limit
     in `whyNot` — which is the shape this screen drew before it was checked. */
  /* The figure, from `plan.limits` rather than from a format this test
     happens to remember — the per-file bound was "256 KB" and is now
     "262144 bytes", and an assertion spelling it out went red for a wording
     change rather than for a broken promise. */
  it("names the bound it breached, as the number the plan carries", () => {
    expect(REFUSALS["too-many-files"]).toContain(String(MIXED.limits.files));
    expect(REFUSALS["file-too-big"]).toContain(String(MIXED.limits.fileBytes));
  });

  /**
   * The ticket's criterion: **every blocking message says what to do.**
   *
   * The assertion that stood here was `/Drop|Split|remove|fewer/i`, and it
   * could not fail. Every refusal the planner raises contains the word *drop*
   * as a **noun** — "this drop holds 201 files", "a file in a drop is at
   * most", "is in this drop twice" — so a case-insensitive match found the
   * subject of the sentence and never an instruction. QA proved it by deleting
   * the remedy from a refusal that had one, regenerating, and watching 1141
   * tests pass.
   *
   * So the remedy is looked for where a remedy actually lives: **after the
   * first clause**, as a capitalised imperative. A diagnosis cannot satisfy
   * it, because the word that used to satisfy it is lower-case and in the
   * subject.
   */
  const remedy = (says: string) => {
    const stop = says.indexOf(". ");
    return stop === -1 ? "" : says.slice(stop + 2).trim();
  };
  /**
   * An allowlist, and **failing on a verb it has not met is the point.**
   *
   * There is no way to ask whether a word is an imperative, so the choice is
   * between this and "the clause is non-empty", which the original defect
   * would have passed. A new verb makes this red until somebody reads the
   * sentence and agrees it is a remedy — loudly, which is the opposite of what
   * happened last time. `Shorten` arrived exactly that way, when the server
   * gave the per-file bound an instruction.
   */
  const IMPERATIVE =
    /^(Drop|Split|Remove|Rename|Write|Put|Ask|Fix|Take|Use|Name|Add|Shorten|Give|Keep|Move)\b/;

  it.each(Object.entries(REFUSALS))("%s tells somebody what to do about it", (_which, says) => {
    expect(remedy(says)).toMatch(IMPERATIVE);
  });

  /* The guard is only worth having if it tells the two apart rather than
     failing everything, so this pins the half that passes. It is a count and
     not a list: the server is adding remedies to the rest, and a test naming
     today's five would go red for the fix landing. */
  it("tells a remedy from a bare diagnosis", () => {
    const sentences = Object.values(REFUSALS);
    const withRemedy = sentences.filter((s) => IMPERATIVE.test(remedy(s)));
    expect(withRemedy.length).toBeGreaterThanOrEqual(5);
    expect(withRemedy.length).toBeLessThanOrEqual(sentences.length);
    /* And a diagnosis with its remedy cut off does not pass, which is the
       mutation QA used to prove the old assertion was hollow. */
    const cut = sentences.map((s) => s.split(". ")[0] + ".");
    for (const says of cut) expect(remedy(says)).not.toMatch(IMPERATIVE);
  });
});
