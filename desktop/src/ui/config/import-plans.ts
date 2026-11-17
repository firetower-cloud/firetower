/**
 * Specimen `ImportPlan`s: one per state the review has to draw.
 *
 * **Nothing in the product imports this file.** It is read by
 * `import-review.test.tsx`, by `import-plan.test.ts` and by the dev harness at
 * `/review.html`, which is what lets every state of this screen be built,
 * photographed and asserted before the plan endpoint is reachable from a drop
 * (#358). A fixture is also the only way to hold a state like *23 profiles,
 * two of them blocked* still long enough to look at it.
 *
 * **These sentences are a specification, not decoration.** `PlanProblem.says`
 * and `ImportPlan.whyNot` are written by the server, so the wording the threat
 * model requires — a hidden resource and a nonexistent one reading identically
 * — has to be emitted there. What is here is the specimen the review was drawn
 * against and the thing `oracleWording` is run over, so a sentence that drifts
 * back to "is not here" fails a test rather than shipping.
 */
import type {
  BodyDiff,
  FieldDiff,
  ImportPlan,
  PlanEntry,
  PlanLimits,
  PlanProblem,
  PlanTarget,
} from "~/api/generated/model";
import { FIELD_GROUPS } from "./import-plan";

/** What the endpoint takes. One drop, stated so a client can refuse early. */
export const LIMITS: PlanLimits = { files: 200, fileBytes: 2_097_152, totalBytes: 26_214_400, depth: 6 };

/**
 * A list value, one item a line.
 *
 * `FieldDiff.before` and `after` are strings, so a list arrives as one — and
 * the review draws `delegates_to` and `skills` as items with a `+`/`−` gutter,
 * because a team of four becoming five is the commonest overwrite in the
 * feature. Newline is the separator these specimens use: a profile's name
 * cannot contain one, and `", "` can appear inside a value.
 */
export const list = (...items: string[]) => items.join("\n");

/** The sixteen fields of a profile, in the file's own vocabulary. */
type Values = {
  name: string;
  does: string;
  body: string;
  engine: string;
  placement: string;
  machine: string;
  account: string;
  directory: string;
  can_delegate: string;
  delegates_to: string;
  skills: string;
  include_always_on: string;
  include_repo_defaults: string;
  on_usage_limit: string;
  on_child_limit: string;
  settings: { model: string; effort: string; mode: string; sandbox: string };
};

/** A field the file changes, or — with `after` absent — one it resets. */
type Move = { to?: string; reset?: string; body?: BodyDiff };

const SETTINGS = ["model", "effort", "mode", "sandbox"] as const;

/**
 * Every one of the sixteen fields as a `FieldDiff`, unchanged unless named.
 *
 * Written as "here is the profile, and here is what moved" because that is how
 * the server computes it and how somebody reads it. All sixteen are always
 * produced: a fixture that only listed the changes could not prove the
 * criterion that all sixteen are always drawn.
 */
function diffFor(now: Values, moves: Partial<Record<string, Move>> = {}): FieldDiff[] {
  const out: FieldDiff[] = [];
  for (const { fields } of FIELD_GROUPS)
    for (const field of fields) {
      if (field === "settings") {
        out.push({
          field: "settings",
          before: "four controls, each optional",
          after: "four controls, each optional",
          change: "unchanged",
          settings: SETTINGS.map((setting) => {
            const m = moves[`settings.${setting}`];
            const before = now.settings[setting];
            if (!m) return { setting, before, after: before, change: "unchanged" as const };
            if (m.reset !== undefined)
              return { setting, before, after: m.reset, change: "reset" as const };
            return { setting, before, after: m.to!, change: "changed" as const };
          }),
        });
        continue;
      }
      const before = now[field as keyof Values] as string;
      const m = moves[field];
      const row: FieldDiff = m
        ? m.reset !== undefined
          ? { field, before, after: m.reset, change: "reset" }
          : { field, before, after: m.to!, change: "changed" }
        : { field, before, after: before, change: "unchanged" };
      if (field === "body") row.body = m?.body ?? { changedLines: 0, added: 0, removed: 0, unified: "" };
      out.push(row);
    }
  return out;
}

/* ── What this installation holds, and what the files say ─────────────── */

const target = (over: Partial<PlanTarget> & { name: string; path: string }): PlanTarget => ({
  id: `ro_${over.path.split("/").pop()}`,
  key: null,
  mayWrite: true,
  ...over,
});

const DESIGNER = target({ name: "Designer", path: "u/kevin/designer_01m3qbzd", key: "designer" });
const ENGINEER = target({ name: "Engineer", path: "u/kevin/engineer_01m3qc02", key: "engineer" });
const MANAGER = target({
  name: "Engineering Manager",
  path: "u/kevin/engineering-manager_01m3qc1f",
  key: "engineering-manager",
});
/** Predates the format, which is what makes the name fallback necessary. */
const QA = target({ name: "QA", path: "u/kevin/qa_01m3q9x7" });
const ADVISOR = target({
  name: "Security Advisor",
  path: "u/kevin/security-advisor_01m3qc33",
  key: "security-advisor",
});

const designer: Values = {
  name: "Designer",
  does: "Handle design and prototyping tasks, producing work that fits the application's existing experience.",
  body: "48 lines",
  engine: "ClaudeCode",
  placement: "the lead chooses",
  machine: "left open",
  account: "left open",
  directory: "left open",
  can_delegate: "false",
  delegates_to: "none",
  skills: list("prototype", "firetower-surfaces", "firetower-artifacts", "apple-design", "human-ui-copy"),
  include_always_on: "true",
  include_repo_defaults: "true",
  on_usage_limit: "wait",
  on_child_limit: "ask",
  settings: { model: "opus", effort: "high", mode: "left open", sandbox: "left open" },
};

const engineer: Values = {
  ...designer,
  name: "Engineer",
  does: "Turn an approved specification and implementation ticket into working, tested, maintainable code.",
  body: "62 lines",
  placement: "its own workspace",
  machine: "build-01",
  directory: "Platform",
  /* The qualified form, which is how a profile says which of two reachable
     skills of the same name it means. Drawn rather than assumed away. */
  skills: list("code-review", "firetower/dataviz", "run"),
  on_usage_limit: "same",
  settings: { model: "sonnet", effort: "medium", mode: "left open", sandbox: "workspace" },
};

const manager: Values = {
  ...designer,
  name: "Engineering Manager",
  does: "Orchestrate feature delivery from the initial request to draft pull requests ready for review.",
  body: "96 lines",
  placement: "its own workspace",
  can_delegate: "true",
  delegates_to: list("Designer", "Engineer", "QA"),
  skills: list("wayfinder", "to-spec-artifact", "to-tickets"),
  on_child_limit: "reroute",
};

const qa: Values = {
  ...designer,
  name: "QA",
  does: "Validate implementation work against its acceptance criteria and identify regressions.",
  body: "54 lines",
  placement: "its own workspace",
  settings: { model: "sonnet", effort: "left open", mode: "left open", sandbox: "left open" },
};

const advisor: Values = {
  ...designer,
  name: "Security Advisor",
  does: "Threat-model the scope and review implementation diffs for security risk.",
  body: "58 lines",
  skills: list("security-review", "code-review"),
};

/* ── The conditions, in the wording the threat model requires ─────────────
   Each names the offending value, says what to do, and reads the same whether
   the resource is hidden from this person or absent from the installation.
   Naming what they *can* reach is not an oracle: it is their own list. */

const problem = (over: PlanProblem): PlanProblem => over;

const UNKNOWN_MACHINE = problem({
  path: "profiles/security-advisor/PROFILE.md",
  line: 8,
  key: "machine",
  says:
    "machine: mac-studio is not available to you. Name one of yours (build-01, build-02, dev-mini), or ask for access to mac-studio.",
});

const UNKNOWN_ACCOUNT = problem({
  path: "profiles/cost-watcher/PROFILE.md",
  line: 11,
  key: "account",
  says:
    "account: team-anthropic is not available to you. Use one of yours (kevin-claude-max, team-codex), or ask for access to team-anthropic.",
});

/* A directory somebody may read and not write blocks here rather than failing
   during the apply, and it takes the same wording as one they cannot see: a
   directory they cannot file into is not available to them either way. */
const UNWRITABLE_DIRECTORY = problem({
  path: "profiles/infra-engineer/PROFILE.md",
  line: 9,
  key: "directory",
  says:
    "directory: Platform is not available to you. File it somewhere you can write (u/kevin, d/eng), or ask for write access to Platform.",
});

const UNKNOWN_TEAMMATE = problem({
  path: "profiles/engineering-manager/PROFILE.md",
  line: 19,
  key: "delegates_to[3]",
  says:
    "delegates_to[3]: Tech Writer is not available to you. It is the fourth name in its team. Use a profile you can reach (Designer, Engineer, QA, Security Advisor), or take the name out of the file.",
});

const UNREACHABLE_SKILL = problem({
  path: "profiles/engineering-manager/PROFILE.md",
  line: 26,
  key: "skills[2]",
  says:
    "skills[2]: to-tickets is not available to you. It is the third skill in its list. Ask for access to it, or take it out of the file.",
});

/* Two reachable skills may share a name, and the delivery side sends neither
   rather than letting one win — so both are named, with where each lives.
   Not an oracle: this person can reach both already. */
const COLLIDING_SKILL = problem({
  path: "profiles/docs-writer/PROFILE.md",
  line: 24,
  key: "skills[1]",
  says:
    "skills[1]: dataviz matches two skills you can reach: firetower/dataviz and d/eng/dataviz. Write the one you mean in full, as firetower/dataviz or d/eng/dataviz.",
});

const MISSPELLED_KEY = problem({
  path: "profiles/designer/PROFILE.md",
  line: 6,
  key: "placment",
  says: "placment is not a key Firetower reads, so nothing here sets a placement. Did you mean placement?",
});

const BAD_ENUM = problem({
  path: "profiles/engineer/PROFILE.md",
  line: 31,
  key: "settings.effort",
  says: "settings.effort: maximum is not a value effort takes. It takes low, medium or high.",
});

const WONT_PARSE = problem({
  path: "profiles/qa-engineer/PROFILE.md",
  line: 7,
  key: null,
  says:
    "The frontmatter does not parse: mapping values are not allowed in this context. Nothing in this file was read, so there is nothing to show from it. Fix the line and drop the folder again.",
});

const NO_DOES = problem({
  path: "profiles/security-advisor/PROFILE.md",
  line: 2,
  key: "does",
  says:
    "does is required and this file has none. It is the line a lead reads to decide whether to hand this profile work. Add one under name.",
});

/* ── Entries ──────────────────────────────────────────────────────────── */

const newly = (key: string, name: string, values: Values, over: Partial<PlanEntry> = {}): PlanEntry => ({
  key,
  name,
  path: `profiles/${key}/PROFILE.md`,
  outcome: { kind: "new", answered: false, filed: "u/kevin" },
  warnings: [],
  ...over,
});

const over = (
  key: string,
  name: string,
  profile: PlanTarget,
  now: Values,
  moves: Partial<Record<string, Move>> = {},
  rest: Partial<PlanEntry> = {},
): PlanEntry => ({
  key,
  name,
  path: `profiles/${key}/PROFILE.md`,
  outcome: {
    kind: "overwrite",
    answered: false,
    adoptsKey: profile.key === null,
    profile,
    diff: diffFor(now, moves),
  },
  warnings: [],
  ...rest,
});

const blocked = (
  key: string,
  name: string | null,
  problems: PlanProblem[],
  rest: Partial<PlanEntry> = {},
): PlanEntry => ({
  key,
  name,
  path: `profiles/${key}/PROFILE.md`,
  outcome: { kind: "blocked", problems },
  warnings: [],
  ...rest,
});

/* ── The plans ────────────────────────────────────────────────────────── */

/** The first drop of a library: five profiles, none of them here yet. */
export const ALL_NEW: ImportPlan = {
  appliable: true,
  whyNot: [],
  ignored: [],
  limits: LIMITS,
  entries: [
    newly("designer", "Designer", designer),
    newly("engineer", "Engineer", engineer),
    newly("engineering-manager", "Engineering Manager", manager),
    newly("qa", "QA", qa),
    newly("security-advisor", "Security Advisor", advisor),
  ],
};

/**
 * The second drop, and the shape the screen will usually be in.
 *
 * Three overwrites — one of them a reset and a rewritten body, one a team
 * gaining a member, one with nothing to do — a candidate, and a refusal. Two
 * files in the folder were not profiles, which is normal and is said plainly.
 */
export const MIXED: ImportPlan = {
  appliable: false,
  whyNot: [
    "Nothing in this drop imports while Security Advisor is blocked. Fix profiles/security-advisor/PROFILE.md, or exclude it.",
    "qa-engineer may be the profile you already have called QA. Answer on its row, and the import can go ahead.",
  ],
  ignored: ["README.md", ".DS_Store"],
  limits: LIMITS,
  entries: [
    over("designer", "Designer", DESIGNER, designer, {
      "settings.model": { to: "sonnet" },
      "settings.effort": { reset: "medium" },
      body: {
        to: "12 added, 3 removed",
        body: {
          changedLines: 15,
          added: 12,
          removed: 3,
          unified: [
            "@@ -12,7 +12,9 @@ ## Your skill",
            " Use the `prototype` skill when the assignment involves creating a prototype.",
            "-Use the `<project-name>-surfaces` skill matching the project if available.",
            "+Use the `<project-name>-surfaces` skill matching the project you are on,",
            "+**before** proposing a layout. It is mandatory, not advisory.",
            " Use the `apple-design` skill as a guide to the best UI and UX practices.",
          ].join("\n"),
        },
      },
    }),
    over("engineer", "Engineer", ENGINEER, engineer),
    over("engineering-manager", "Engineering Manager", MANAGER, manager, {
      delegates_to: { to: list("Designer", "Engineer", "QA", "Security Advisor") },
    }),
    {
      key: "qa-engineer",
      name: "QA Engineer",
      path: "profiles/qa-engineer/PROFILE.md",
      outcome: {
        kind: "candidate",
        proposals: [
          {
            profile: QA,
            why: "likeName",
            says:
              "QA is filed at u/kevin/qa_01m3q9x7 and carries no key, so Firetower cannot tell whether this file is that profile.",
          },
        ],
      },
      warnings: [],
    },
    blocked("security-advisor", "Security Advisor", [UNKNOWN_MACHINE]),
  ],
};

/** Five profiles, six conditions, nothing importable as it stands. */
export const ALL_BLOCKED: ImportPlan = {
  appliable: false,
  whyNot: ["Fix the files and drop the folder again. Each reason below names its file and the line to open."],
  ignored: [],
  limits: LIMITS,
  entries: [
    blocked("designer", "Designer", [MISSPELLED_KEY]),
    blocked("engineer", "Engineer", [BAD_ENUM]),
    blocked("engineering-manager", "Engineering Manager", [UNKNOWN_TEAMMATE, UNREACHABLE_SKILL]),
    /* No name, because the file never parsed — and so no field panel. */
    blocked("qa-engineer", null, [WONT_PARSE]),
    blocked("security-advisor", "Security Advisor", [NO_DOES]),
  ],
};

/** One folder, kept, whose file now gives the profile a different name. */
export const RENAME: ImportPlan = {
  appliable: true,
  whyNot: [],
  ignored: [],
  limits: LIMITS,
  entries: [
    {
      key: "designer",
      name: "Product Designer",
      path: "profiles/designer/PROFILE.md",
      outcome: {
        kind: "rename",
        answered: false,
        adoptsKey: false,
        from: "Designer",
        to: "Product Designer",
        profile: DESIGNER,
        diff: diffFor(designer, {
          name: { to: "Product Designer" },
          skills: { to: list("prototype", "firetower-surfaces", "firetower-artifacts", "human-ui-copy") },
        }),
      },
      warnings: [],
    },
  ],
};

/**
 * A near match: one file, one existing profile whose name differs by a capital.
 *
 * Unanswered, which is what makes the plan unappliable. The two answers are on
 * the row; neither is the default, because a default answer is a guess with a
 * nicer name.
 */
export const NEAR_MATCH: ImportPlan = {
  appliable: false,
  whyNot: [
    "designer may be the profile you already have called Designer. Answer on its row, and the import can go ahead.",
  ],
  ignored: [],
  limits: LIMITS,
  entries: [
    {
      key: "designer",
      name: "designer",
      path: "profiles/designer/PROFILE.md",
      outcome: {
        kind: "candidate",
        proposals: [
          {
            profile: DESIGNER,
            why: "nearName",
            says: "Designer is filed at u/kevin/designer_01m3qbzd and differs from this file by one capital letter.",
          },
        ],
      },
      warnings: [
        {
          path: "profiles/designer/PROFILE.md",
          line: 3,
          key: "name",
          says:
            "Creating this as a new profile leaves two whose names differ by one capital letter. A lead picking between them would have nothing to go on.",
        },
      ],
    },
  ],
};

/**
 * The same drop after answering *same profile*.
 *
 * The next plan, not a client-side guess: an answer goes back through
 * `ProfileDrop.answers` and the server resolves it again, which is the only way
 * the sixteen fields can be diffed against the row that was chosen.
 */
export const NEAR_MATCH_ANSWERED: ImportPlan = {
  appliable: true,
  whyNot: [],
  ignored: [],
  limits: LIMITS,
  entries: [
    {
      key: "designer",
      name: "designer",
      path: "profiles/designer/PROFILE.md",
      outcome: {
        kind: "rename",
        answered: true,
        adoptsKey: false,
        from: "Designer",
        to: "designer",
        profile: DESIGNER,
        diff: diffFor(designer, {
          name: { to: "designer" },
          "settings.model": { to: "sonnet" },
        }),
      },
      warnings: [
        {
          path: "profiles/designer/PROFILE.md",
          line: 3,
          key: "name",
          says: "This renames Designer to designer. The profile keeps its history and everything filed against it.",
        },
      ],
    },
  ],
};

/** A drop refused whole: the limit is the fact, and it is named. */
export const OVER_LIMIT: ImportPlan = {
  appliable: false,
  whyNot: [
    "This drop has 412 files. The limit is 200 files, 2 MB a file and 25 MB in total.",
    "Drop the folder of profiles rather than the library that holds it.",
  ],
  ignored: [],
  limits: LIMITS,
  entries: [],
};

/**
 * 23 profiles from a team library: the filter pills, and file order under load.
 *
 * Invented past the first five. Two are blocked, which is what proves a
 * refusal stays findable in a list long enough to scroll.
 */
export const LARGE: ImportPlan = (() => {
  const more: [string, string][] = [
    ["release-manager", "Release Manager"],
    ["docs-writer", "Docs Writer"],
    ["support-triage", "Support Triage"],
    ["data-analyst", "Data Analyst"],
    ["perf-engineer", "Perf Engineer"],
    ["accessibility-reviewer", "Accessibility Reviewer"],
    ["infra-engineer", "Infra Engineer"],
    ["api-reviewer", "API Reviewer"],
    ["localiser", "Localiser"],
    ["dependency-keeper", "Dependency Keeper"],
    ["incident-lead", "Incident Lead"],
    ["onboarding-guide", "Onboarding Guide"],
    ["spec-reviewer", "Spec Reviewer"],
    ["prompt-reviewer", "Prompt Reviewer"],
    ["cost-watcher", "Cost Watcher"],
    ["flake-hunter", "Flake Hunter"],
    ["schema-reviewer", "Schema Reviewer"],
    ["changelog-keeper", "Changelog Keeper"],
  ];
  const says: Record<string, string> = {
    "release-manager": "Cut a release, write the notes, and watch the deploy.",
    "docs-writer": "Turn a merged change into documentation a stranger can follow.",
    "support-triage": "Read an incoming report and decide whether it is a bug.",
    "data-analyst": "Answer a question with a query and a chart, and say what it cannot answer.",
    "perf-engineer": "Profile a slow path and report where the time actually goes.",
    "accessibility-reviewer": "Check a screen against the floor: focus, contrast, reduced motion.",
    "infra-engineer": "Change the deploy, the migrations and the machines, carefully.",
    "api-reviewer": "Read a diff for the contract it changes and for who it breaks.",
    localiser: "Find the strings a change added and the ones it orphaned.",
    "dependency-keeper": "Take an upgrade, run everything, and say what moved.",
    "incident-lead": "Run an incident: timeline, comms, and the write-up after.",
    "onboarding-guide": "Walk a new person through the repository and its rules.",
    "spec-reviewer": "Read a specification as its first reader and say what is thin.",
    "prompt-reviewer": "Read an agent's instructions for the ways they will misfire.",
    "cost-watcher": "Read the month's spend and name the three things that moved it.",
    "flake-hunter": "Find the test that fails one run in forty, and why.",
    "schema-reviewer": "Read a migration for what it locks and what it cannot undo.",
    "changelog-keeper": "Keep the changelog honest about what shipped.",
  };
  const entries: PlanEntry[] = [
    over("designer", "Designer", DESIGNER, designer, {
      "settings.model": { to: "sonnet" },
      "settings.effort": { reset: "medium" },
    }),
    over("engineer", "Engineer", ENGINEER, engineer, { machine: { to: "build-02" } }),
    over("engineering-manager", "Engineering Manager", MANAGER, manager, {
      delegates_to: { to: list("Designer", "Engineer", "QA", "Security Advisor", "Release Manager") },
    }),
    over("qa", "QA", QA, qa),
    blocked("security-advisor", "Security Advisor", [UNKNOWN_MACHINE]),
  ];
  for (const [key, name] of more) {
    if (key === "cost-watcher") {
      entries.push(blocked(key, name, [UNKNOWN_ACCOUNT]));
      continue;
    }
    if (key === "docs-writer") {
      entries.push(blocked(key, name, [COLLIDING_SKILL]));
      continue;
    }
    if (key === "infra-engineer") {
      entries.push(blocked(key, name, [UNWRITABLE_DIRECTORY]));
      continue;
    }
    entries.push(newly(key, name, { ...designer, name, does: says[key]! }));
  }
  return {
    appliable: false,
    whyNot: [
      "Nothing in this drop imports while 4 of these 23 profiles are blocked. Each reason names its file and the line to open.",
    ],
    ignored: ["README.md", ".DS_Store", "profiles/.keep"],
    limits: LIMITS,
    entries,
  };
})();

/** Every specimen, by the name the harness and the shoot script use. */
export const PLANS = {
  "all-new": ALL_NEW,
  mixed: MIXED,
  "all-blocked": ALL_BLOCKED,
  rename: RENAME,
  "near-match": NEAR_MATCH,
  "near-match-answered": NEAR_MATCH_ANSWERED,
  large: LARGE,
  "over-limit": OVER_LIMIT,
} satisfies Record<string, ImportPlan>;

export type PlanName = keyof typeof PLANS;
