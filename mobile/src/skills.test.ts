/**
 * The skills sheet, without a renderer.
 *
 * `mobile/`'s vitest stubs `react-native`, so nothing here can press a row.
 * What it can do is check every answer the sheet draws, which is why those
 * answers live in `skills.ts` rather than inside the component — the same
 * reason `api/workspaces.ts` holds `opens` and `agentName`.
 *
 * **The first block is the one that matters most.** `BUDGET` is duplicated
 * from `desktop/src/skills.ts` under this repository's stated rule for a
 * second client, and a duplicate is only safe while something notices it
 * drifting. These are the desk's numbers written out by hand: changing one
 * side alone fails here rather than shipping a client whose meter is wrong.
 */
import { describe, expect, it } from "vitest";
import {
  BUDGET,
  chipLabel,
  chipShows,
  clashingName,
  confirmLabel,
  fromDefaults,
  groupSkills,
  plan,
  sameSet,
  SMALLEST_BUDGET,
} from "./skills";

describe("the budget, pinned against the desk's copy", () => {
  it("is the same table as desktop/src/skills.ts", () => {
    // Written out rather than compared: there is nothing to import the desk's
    // from, and a literal is what makes a one-sided edit visible in a diff.
    expect(BUDGET).toEqual({
      ClaudeCode: 3000,
      Codex: 2000,
      KimiCode: 2250,
      CursorAgent: 2000,
    });
  });

  it("meters an agent it does not know against the floor", () => {
    // The cliff is what the meter is for, and overstating a limit hides it.
    expect(SMALLEST_BUDGET).toBe(2000);
    expect(BUDGET["Shell"] ?? SMALLEST_BUDGET).toBe(2000);
  });
});

describe("whether the chip is there at all", () => {
  it("is absent while the answer is in flight", () => {
    // "0 skills" before the request lands is the lie the whole `Waiting`
    // docblock is about.
    expect(chipShows({ loading: true, error: null })).toBe(false);
  });

  it("is absent when the request failed", () => {
    // The count falls back to an empty list either way, so a chip here would
    // say "No skills" about a session that is reading seven.
    expect(chipShows({ loading: false, error: "That didn't work." })).toBe(false);
  });

  it("is there once something has come back", () => {
    expect(chipShows({ loading: false, error: null })).toBe(true);
  });
});

describe("what the chip says", () => {
  it("says the noun, not a bare zero", () => {
    // A digit with a noun after it reads as a count that broke.
    expect(chipLabel(0)).toBe("No skills");
  });

  it("counts one in the singular", () => {
    expect(chipLabel(1)).toBe("1 skill");
  });

  it("counts the rest in the plural", () => {
    expect(chipLabel(7)).toBe("7 skills");
    expect(chipLabel(40)).toBe("40 skills");
  });
});

describe("sameSet", () => {
  it("ignores order", () => {
    expect(sameSet(["a", "b"], ["b", "a"])).toBe(true);
  });

  it("is not fooled by a repeat", () => {
    // Two lists of different lengths holding one set are the same set.
    expect(sameSet(["a", "a", "b"], ["a", "b"])).toBe(true);
  });

  it("refuses a subset", () => {
    expect(sameSet(["a"], ["a", "b"])).toBe(false);
  });

  it("calls two empties the same", () => {
    expect(sameSet([], [])).toBe(true);
  });
});

describe("where a selection came from", () => {
  const web = { slug: "acme/web", defaults: ["s1", "s2"] };
  const api = { slug: "acme/api", defaults: ["s3"] };

  it("names the one repository giving defaults", () => {
    expect(fromDefaults(["s1", "s2"], [web], [])).toBe("web defaults");
  });

  it("counts them when there is more than one", () => {
    expect(fromDefaults(["s1", "s2", "s3"], [web, api], [])).toBe("defaults from 2 repos");
  });

  it("says always on when no repository gave anything", () => {
    expect(fromDefaults(["s9"], [{ slug: "acme/web", defaults: [] }], ["s9"])).toBe("always on");
  });

  it("says nothing at all once the set has been edited", () => {
    // The chip's subtitle is a claim about provenance. One extra skill and it
    // is no longer true, so there is no sentence to show.
    expect(fromDefaults(["s1", "s2", "s4"], [web], [])).toBeNull();
  });

  it("says nothing for an empty selection", () => {
    expect(fromDefaults([], [web], [])).toBeNull();
  });

  it("says nothing when there were no defaults to match", () => {
    expect(fromDefaults(["s1"], [], [])).toBeNull();
  });
});

/* A library small enough to read and wide enough to group. `tokens` are what
   the meter adds up; `description` is what search also looks at. */
const LIB = [
  { id: "s1", name: "code-review", description: "Read a diff for correctness bugs.", tokens: 400 },
  { id: "s2", name: "dataviz", description: "Charts that read as one system.", tokens: 500 },
  { id: "s3", name: "rust-review", description: "Lifetimes and nothing else.", tokens: 300 },
  { id: "s4", name: "expo-release", description: "Cut a build and push it to TestFlight.", tokens: 600 },
];

describe("the two groups", () => {
  const here = new Set(["s1", "s2"]);

  it("splits by where a skill comes from", () => {
    const groups = groupSkills(LIB, here, "");
    expect(groups.map((g) => g.at)).toEqual(["default", "all"]);
    expect(groups[0]!.rows.map((r) => r.id)).toEqual(["s1", "s2"]);
    expect(groups[1]!.rows.map((r) => r.id)).toEqual(["s3", "s4"]);
  });

  it("keeps a default in its group when it is turned off", () => {
    // Membership is provenance. A row that moved when it was tapped would
    // move out from under the finger that tapped it.
    const groups = groupSkills(LIB, here, "");
    expect(groups[0]!.rows.map((r) => r.id)).toContain("s1");
  });

  it("drops a group with nothing in it rather than drawing a heading", () => {
    expect(groupSkills(LIB, new Set(), "").map((g) => g.at)).toEqual(["all"]);
  });

  it("searches the name", () => {
    const groups = groupSkills(LIB, here, "review");
    expect(groups.flatMap((g) => g.rows.map((r) => r.id))).toEqual(["s1", "s3"]);
  });

  it("searches the description too, and not case-sensitively", () => {
    const groups = groupSkills(LIB, here, "TESTFLIGHT");
    expect(groups.flatMap((g) => g.rows.map((r) => r.id))).toEqual(["s4"]);
  });

  it("returns nothing at all when nothing matches, so the sheet can say so", () => {
    expect(groupSkills(LIB, here, "kubernetes")).toEqual([]);
  });

  it("keeps the grouping intact while searching", () => {
    // A search narrows the rows and never flattens the two groups into one.
    const groups = groupSkills(LIB, here, "review");
    expect(groups.map((g) => [g.at, g.rows.map((r) => r.id)])).toEqual([
      ["default", ["s1"]],
      ["all", ["s3"]],
    ]);
  });
});

describe("two of one name", () => {
  const twins = [
    { id: "a", name: "code-review" },
    { id: "b", name: "code-review" },
    { id: "c", name: "dataviz" },
  ];

  it("is refused by name, not by id", () => {
    // The folder on the worker *is* the name, so the agent could only be given
    // one of them — and `choose_skills` returns an error rather than picking.
    expect(clashingName(twins, new Set(["a", "b"]))).toBe("code-review");
  });

  it("is fine while only one of the two is on", () => {
    expect(clashingName(twins, new Set(["a", "c"]))).toBeNull();
  });
});

/* One repository, defaults s1 and s2 — the shape the switch reads. */
const WEB = { repoId: "r1", slug: "acme/web", defaults: ["s1", "s2"] };
const API = { repoId: "r2", slug: "acme/api", defaults: ["s3"] };
const every = (repos: { repoId: string }[]) => new Set(repos.map((r) => r.repoId));

const ask = (over: Partial<Parameters<typeof plan>[0]> = {}) =>
  plan({
    all: LIB,
    picked: new Set(["s1", "s2"]),
    live: ["s1", "s2"],
    budget: 3000,
    repos: [WEB],
    aimedAt: every([WEB]),
    want: null,
    ...over,
  });

describe("what confirming would do", () => {
  it("adds up only what is ticked", () => {
    expect(ask().spend).toBe(900);
    expect(ask({ picked: new Set(["s1", "s2", "s3", "s4"]) }).spend).toBe(1800);
    expect(ask({ picked: new Set() }).spend).toBe(0);
  });

  it("is over only past the budget, not at it", () => {
    // The cliff is "past its budget", so exactly the budget still fits.
    expect(ask({ picked: new Set(["s1", "s2"]), budget: 900 }).over).toBe(false);
    expect(ask({ picked: new Set(["s1", "s2"]), budget: 899 }).over).toBe(true);
  });

  it("counts the change in both directions", () => {
    const p = ask({ picked: new Set(["s2", "s3", "s4"]) });
    expect([p.added, p.gone]).toEqual([2, 1]);
    expect(p.dirty).toBe(true);
  });

  it("is not dirty when the draft is what the session is already reading", () => {
    const p = ask({ picked: new Set(["s2", "s1"]) });
    expect(p.dirty).toBe(false);
    expect(p.nothingToDo).toBe(true);
  });

  it("blocks a selection the agent would drop whole", () => {
    expect(ask({ budget: 100 }).blocked).toBe(true);
  });

  it("blocks two of one name", () => {
    const twins = [
      { id: "a", name: "code-review", tokens: 10 },
      { id: "b", name: "code-review", tokens: 10 },
    ];
    const p = ask({ all: twins, picked: new Set(["a", "b"]), live: [] });
    expect(p.clash).toBe("code-review");
    expect(p.blocked).toBe(true);
  });
});

describe("an always-on skill is a choice, not a lock", () => {
  /* The design call this port rests on, pinned. `choose_skills` takes the
     whole selection and special-cases nothing; `set_for_session` deletes every
     pin outside it. So unticking one that is on everywhere is a change the
     server will accept, and the sheet has to offer it — a disabled tick would
     make the phone refuse what the desk allows. */
  it("unticking one is an ordinary change, and nothing refuses it", () => {
    const p = ask({ picked: new Set(["s1"]), live: ["s1", "s2"] });
    expect(p.gone).toBe(1);
    expect(p.dirty).toBe(true);
    expect(p.blocked).toBe(false);
  });

  it("still counts toward the defaults comparison it came from", () => {
    // `defaultsHere` is repository defaults ∪ always-on, and `fromDefaults`
    // measures against the same union — so dropping one leaves the selection
    // no longer simply "your defaults".
    expect(fromDefaults(["s1"], [{ slug: "acme/web", defaults: ["s1"] }], ["s2"])).toBeNull();
  });
});

describe("the defaults switch", () => {
  it("is already on when the selection is every repository's default", () => {
    const p = ask({ picked: new Set(["s1", "s2"]), repos: [WEB] });
    expect(p.already).toBe(true);
    expect(p.on).toBe(true);
  });

  it("is off the moment the selection moves away from them", () => {
    const p = ask({ picked: new Set(["s1"]), repos: [WEB] });
    expect(p.already).toBe(false);
    expect(p.on).toBe(false);
  });

  it("is off when one of two repositories disagrees", () => {
    const p = ask({ picked: new Set(["s1", "s2"]), repos: [WEB, API], aimedAt: every([WEB, API]) });
    expect(p.already).toBe(false);
  });

  it("is not on for an empty selection, whatever the repositories say", () => {
    // Nothing ticked is not a selection to make the default.
    const p = ask({ picked: new Set(), repos: [{ ...WEB, defaults: [] }] });
    expect(p.already).toBe(false);
  });

  it("writes nothing when the repository already matches", () => {
    const p = ask({ picked: new Set(["s1", "s2"]), want: true, repos: [WEB] });
    expect(p.setsDefaults).toBe(false);
    expect(p.writesDefaults).toBe(false);
  });

  it("writes the whole selection, not the additions", () => {
    const p = ask({ picked: new Set(["s1", "s2", "s3"]), want: true, repos: [WEB] });
    expect(p.setsDefaults).toBe(true);
    expect(p.aimed.map((r) => r.repoId)).toEqual(["r1"]);
  });

  it("turned off, clears only the ones that are ticked", () => {
    const p = ask({ picked: new Set(["s1"]), want: false, repos: [WEB] });
    expect(p.clearsDefaults).toBe(true);
  });

  it("turned off against a repository that has none of them, writes nothing", () => {
    const p = ask({ picked: new Set(["s4"]), want: false, repos: [WEB] });
    expect(p.clearsDefaults).toBe(false);
  });

  it("only writes the repositories it is aimed at", () => {
    const p = ask({
      picked: new Set(["s4"]),
      want: true,
      repos: [WEB, API],
      aimedAt: new Set(["r2"]),
    });
    expect(p.aimed.map((r) => r.repoId)).toEqual(["r2"]);
  });

  it("makes a confirmation worth sending even when the selection has not moved", () => {
    const p = ask({ picked: new Set(["s1", "s2"]), live: ["s1", "s2"], want: false, repos: [WEB] });
    expect(p.dirty).toBe(false);
    expect(p.nothingToDo).toBe(false);
  });
});

describe("what the button says", () => {
  it("carries the count once something has changed", () => {
    expect(confirmLabel({ clash: null, over: false, dirty: true, writesDefaults: false, count: 8 })).toBe(
      "Confirm 8 skills",
    );
  });

  it("counts one in the singular", () => {
    expect(confirmLabel({ clash: null, over: false, dirty: true, writesDefaults: false, count: 1 })).toBe(
      "Confirm 1 skill",
    );
  });

  it("says Save when only the defaults are being written", () => {
    expect(confirmLabel({ clash: null, over: false, dirty: false, writesDefaults: true, count: 3 })).toBe(
      "Save",
    );
  });

  it("refuses rather than counting, when it cannot be sent", () => {
    expect(confirmLabel({ clash: null, over: true, dirty: true, writesDefaults: false, count: 9 })).toBe(
      "Can't confirm",
    );
    expect(
      confirmLabel({ clash: "code-review", over: false, dirty: true, writesDefaults: false, count: 2 }),
    ).toBe("Can't confirm");
  });

  it("is a plain Confirm when there is nothing to say about it", () => {
    expect(confirmLabel({ clash: null, over: false, dirty: false, writesDefaults: false, count: 2 })).toBe(
      "Confirm",
    );
  });
});
