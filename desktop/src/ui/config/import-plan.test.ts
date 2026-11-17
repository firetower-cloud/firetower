/**
 * Reading a plan: the arithmetic that decides whether a destructive button is
 * available, and the wording a blocked reason is allowed to use.
 *
 * Two things are worth a test here rather than a comment.
 *
 * **`appliable` stops being true the moment somebody acts.** The plan is the
 * truth about the drop it was computed for; an exclusion makes it the truth
 * about a drop nobody is looking at. Both directions are checked — the
 * server's own sentences while they hold, and the derivation after that —
 * because the failure modes point opposite ways: always re-deriving throws
 * away wording the server is better placed to write, and always trusting
 * `appliable` leaves the primary dead after somebody has done exactly what the
 * sentence asked.
 *
 * **A blocked reason must not say whether something exists.** That is the
 * threat model's requirement and it is a property of a string, so it is
 * checked over every specimen rather than reviewed once.
 */
import { describe, expect, it } from "vitest";
import type { ImportPlan, PlanEntry } from "~/api/generated/model";
import {
  FIELD_COUNT,
  UNTOUCHED,
  appliability,
  bucketOf,
  composition,
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
import { ALL_BLOCKED, ALL_NEW, LARGE, MIXED, NEAR_MATCH, OVER_LIMIT, PLANS, RENAME } from "./import-plans";

const sel = (excluded: string[] = [], answers = {}) => ({ excluded: new Set(excluded), answers });
const entry = (plan: ImportPlan, key: string): PlanEntry =>
  plan.entries.find((e) => e.key === key)!;

describe("whether the import can go ahead", () => {
  it("is the plan's own answer while nobody has touched it", () => {
    expect(appliability(MIXED, UNTOUCHED)).toEqual({
      appliable: false,
      reasons: MIXED.whyNot,
    });
    expect(appliability(ALL_NEW, UNTOUCHED)).toEqual({ appliable: true, reasons: [] });
  });

  /* The sentence the plan arrived with says "exclude it to import the other 4".
     Doing that has to work, which means the server's verdict cannot survive it. */
  it("re-derives once something has been excluded", () => {
    const after = appliability(MIXED, sel(["security-advisor"]));
    expect(after.appliable).toBe(false); // the candidate is still unanswered
    expect(after.reasons).toEqual(["One profile is waiting on an answer."]);

    const both = appliability(MIXED, sel(["security-advisor", "qa-engineer"]));
    expect(both).toEqual({ appliable: true, reasons: [] });
  });

  it("is held up by an unanswered candidate, and freed by answering one", () => {
    expect(appliability(NEAR_MATCH, UNTOUCHED).appliable).toBe(false);
    const answered = sel([], { designer: { kind: "newProfile" } as const });
    expect(appliability(NEAR_MATCH, answered)).toEqual({ appliable: true, reasons: [] });
  });

  it("refuses a drop whose limit was breached, and names the limit", () => {
    const { appliable, reasons } = appliability(OVER_LIMIT, UNTOUCHED);
    expect(appliable).toBe(false);
    expect(reasons.join(" ")).toMatch(/The limit is 200 files/);
  });

  it("says so when everything has been excluded", () => {
    const none = appliability(ALL_NEW, sel(ALL_NEW.entries.map((e) => e.key)));
    expect(none.appliable).toBe(false);
    expect(none.reasons).toEqual(["All 5 profiles in this drop are excluded."]);
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

  /* The only way to import fewer profiles than you dropped is to exclude some,
     so the count of them is beside the button that does it, at every width. */
  it("keeps the excluded count beside the primary", () => {
    expect(foot(MIXED, sel(["security-advisor"])).excluded).toBe(1);
    expect(foot(ALL_NEW, sel(["qa", "designer"])).excluded).toBe(2);
  });

  it("warns, rather than refusing, when a field would go back to its default", () => {
    const f = foot(MIXED, sel(["security-advisor", "qa-engineer"]));
    expect(f.tone).toBe("warn");
    expect(`${f.lead} ${f.rest}`).toBe("One field would go back to its default, named in the diff above.");
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
    expect(outcomeOf(one, sel([], { designer: { kind: "newProfile" } }))).toBe("new");
    /* The file calls it `designer`, the row is `Designer` — so saying they are
       the same profile is a rename, and the review has to say that word. */
    expect(
      outcomeOf(one, sel([], { designer: { kind: "sameProfile", profile: "ro_designer_01m3qbzd" } })),
    ).toBe("rename");
  });

  it("gives a rename its own word and an overwrite's pip", () => {
    expect(stateWord(entry(RENAME, "designer"), UNTOUCHED)).toBe("will rename");
    expect(pipOf(entry(RENAME, "designer"), UNTOUCHED)).toBe("overwrite");
    /* A rename writes the same row, so it is not sorted under *New*. */
    expect(bucketOf("rename")).toBe("overwrite");
  });

  it("says when nothing would change, and keeps the row importable", () => {
    const same = entry(MIXED, "engineer");
    expect(stateWord(same, UNTOUCHED)).toBe("nothing would change");
    expect(pipOf(same, UNTOUCHED)).toBe("nochange");
    expect(appliability(MIXED, sel(["security-advisor", "qa-engineer"])).appliable).toBe(true);
  });

  /* A control, not a finding: amber is spent on a reset and on a name that may
     be a duplicate, and an unanswered row is neither. */
  it("gives an unanswered candidate no hue", () => {
    expect(pipOf(entry(NEAR_MATCH, "designer"), UNTOUCHED)).toBe("asking");
  });
});

describe("the diff", () => {
  it("has sixteen fields and six groups", () => {
    expect(FIELD_COUNT).toBe(16);
    const diff = diffOf(entry(MIXED, "designer"))!;
    expect(diff).toHaveLength(16);
    expect(grouped(diff).map((g) => g.group)).toEqual([
      "Identity",
      "Where and how its children run",
      "Delegation",
      "Skills",
      "When a child runs out of allowance",
      "How it runs its agent",
    ]);
    expect(grouped(diff).flatMap((g) => g.rows)).toHaveLength(16);
  });

  /* A client one release behind its server silently dropping a row would be
     the exact failure this screen exists to remove, with a version number on. */
  it("draws a field it has never heard of rather than dropping it", () => {
    const diff = diffOf(entry(MIXED, "designer"))!;
    const extra = [...diff, { field: "mood", before: "calm", after: "brisk", change: "changed" as const }];
    const groups = grouped(extra);
    expect(groups[groups.length - 1]).toEqual({
      group: "Other fields",
      rows: [extra[extra.length - 1]],
    });
  });

  it("names what moved, counts what did not, and marks a reset as its own kind", () => {
    const diff = diffOf(entry(MIXED, "designer"))!;
    expect(moved(diff)).toEqual([
      { field: "body", reset: false },
      { field: "settings.model", reset: false },
      { field: "settings.effort", reset: true },
    ]);
    /* Two of the three live under `settings`, which is one of the sixteen. */
    expect(unchanged(diff)).toBe(14);
  });

  it("collects every reset in the included part of the drop", () => {
    expect(resets(MIXED, UNTOUCHED)).toEqual([{ profile: "Designer", field: "settings.effort" }]);
    expect(resets(MIXED, sel(["designer"]))).toEqual([]);
  });
});

describe("what arrives expanded", () => {
  /* The two things that can surprise you are never behind a disclosure. */
  it("opens a blocked row and a row carrying a reset, and nothing else", () => {
    expect([...openOnArrival(MIXED)].sort()).toEqual(["designer", "security-advisor"]);
    expect([...openOnArrival(ALL_BLOCKED)].sort()).toEqual(ALL_BLOCKED.entries.map((e) => e.key).sort());
    expect([...openOnArrival(ALL_NEW)]).toEqual([]);
  });

  it("opens a drop of one, the way AddSkill opens a single bundle", () => {
    expect([...openOnArrival(RENAME)]).toEqual(["designer"]);
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
    expect(t.blocked).toBe(4);
  });

  /* Rows stay in the order the folder was read. The plan states it — "one
     entry per bundle, in path order" — and nothing here may re-sort it. */
  it("is the plan's own order, which is not alphabetical", () => {
    const keys = LARGE.entries.map((e) => e.key);
    expect(keys).not.toEqual([...keys].sort());
    expect(keys[0]).toBe("designer");
  });
});

describe("a blocked reason may not say whether something exists", () => {
  /* From the threat model: a plan that tells a hidden resource apart from an
     absent one is an enumeration oracle for machines, subscriptions,
     directories and other people's profiles — and a drop is machine-readable.
     Every sentence in every specimen is held to it. */
  const sentences = Object.entries(PLANS).flatMap(([name, plan]) => [
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

  it("has sentences to check", () => {
    expect(sentences.length).toBeGreaterThan(14);
  });

  it.each(sentences)("%s reads the same hidden or absent", (_where, says) => {
    expect(oracleWording(says)).toEqual([]);
  });

  /* The wording is only half the job: it still has to tell somebody what to
     do, which is where an evasive rewrite usually lands. */
  it.each(
    Object.values(PLANS).flatMap((plan) =>
      plan.entries.flatMap((e) =>
        e.outcome.kind === "blocked"
          ? e.outcome.problems.map((p) => [`${p.path}:${p.line}`, p.says] as const)
          : [],
      ),
    ),
  )("%s still says what to do", (_where, says) => {
    expect(says).toMatch(/\b(Name|Use|Ask|File|Add|Take|Write|Fix|Did you mean|It takes)\b/);
  });

  it("uses the available-to-you wording on all four nouns", () => {
    const said = sentences.map(([, s]) => s).join(" ");
    for (const noun of ["machine", "account", "directory", "delegates_to"])
      expect(said).toMatch(new RegExp(`${noun}[^.]*is not available to you`));
  });
});
