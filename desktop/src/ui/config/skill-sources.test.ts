/**
 * The one promise the Skills section makes: **the breakdown's lines sum to the
 * figure**, in every state the resolver can be put into.
 *
 * It was broken in two, and both are here. The figure filtered skills with no
 * approved version; the *named* line filtered them too; the always-on and
 * repository-default lines did not. So a version-0 skill named on the list made
 * the lines add to one more than the figure, and one arriving through a
 * **switch** did the same while appearing on no line at all — on a brand-new
 * profile, which is the first thing anybody sees. The second is the worse one,
 * because the only thing on screen was an arithmetic error with no explanation
 * attached.
 *
 * Driven here rather than only through `shoot-profile-skills.mjs` because
 * neither state is reachable by clicking: the desktop hides the defaults tabs
 * while a skill is held, so a version-0 always-on skill has to be made over the
 * API, and two owners with one name needs two accounts. A promise that can only
 * be checked in states somebody can reach is not being checked.
 */
import { describe, expect, it } from "vitest";
import type { Repo, Skill } from "~/api/generated/model";
import { resolve } from "./SkillSources";

const skill = (over: Partial<Skill> & { id: string; name: string }): Skill => ({
  path: "u/kevin",
  description: "",
  version: 1,
  versionId: "sv_1",
  tokens: 900,
  files: 1,
  bytes: 1,
  risk: [],
  author: null,
  builtin: false,
  held: false,
  updatedAt: "2026-11-01T00:00:00Z",
  mayWrite: true,
  mayShare: true,
  defaultIn: [],
  alwaysOn: false,
  slug: over.name,
  ...over,
});

const repos: Repo[] = [{ id: "r_1", slug: "acme/web" } as Repo];

/** Everything the section draws, for one draft. */
const at = (
  library: Skill[],
  named: string[] = [],
  draft: Partial<Parameters<typeof resolve>[0]["draft"]> = {},
) =>
  resolve({
    draft: { agent: "ClaudeCode", includeAlwaysOn: true, includeRepoDefaults: true, ...draft },
    library,
    repos,
    at: "acme/web",
    named: new Set(named),
    shared: false,
  });

/** What the breakdown renders, in the column the figure is compared against. */
const lines = (r: ReturnType<typeof resolve>) => [
  r.includeAlwaysOn ? r.from.always.length : 0,
  r.includeRepoDefaults ? r.from.repo.length : 0,
  r.from.named.length,
];
const sum = (r: ReturnType<typeof resolve>) => lines(r).reduce((a, b) => a + b, 0);

const ordinary = [
  skill({ id: "sk_1", name: "firetower-surfaces", alwaysOn: true }),
  skill({ id: "sk_2", name: "skill-creator", alwaysOn: true }),
  skill({ id: "sk_3", name: "claude-api", defaultIn: ["acme/web"] }),
  skill({ id: "sk_4", name: "dataviz", defaultIn: ["acme/web"] }),
  skill({ id: "sk_5", name: "pr-screenshots" }),
];

describe("the breakdown sums to the figure", () => {
  it("with nothing named — three sources, counted once each", () => {
    const r = at(ordinary);
    expect(r.loads.length).toBe(4);
    expect(sum(r)).toBe(4);
    expect(lines(r)).toEqual([2, 2, 0]);
  });

  it("with a skill named that no source supplies", () => {
    const r = at(ordinary, ["sk_5"]);
    expect(r.loads.length).toBe(5);
    expect(sum(r)).toBe(5);
  });

  it("with a skill named that a switch already supplies — adding zero", () => {
    const r = at(ordinary, ["sk_1"]);
    expect(r.loads.length).toBe(4);
    expect(sum(r)).toBe(4);
    expect(r.dupes.map((s) => s.id)).toEqual(["sk_1"]);
  });

  it("with each switch off", () => {
    for (const off of [{ includeAlwaysOn: false }, { includeRepoDefaults: false }]) {
      const r = at(ordinary, ["sk_5"], off);
      expect(r.loads.length).toBe(3);
      expect(sum(r)).toBe(3);
    }
  });

  /* State B in the report: reachable by clicking, and the lines said 6
     against a figure of 5. */
  it("with a named skill that has no approved version, which it names", () => {
    const library = [...ordinary, skill({ id: "sk_0", name: "deploy-runbook", version: 0 })];
    const r = at(library, ["sk_5", "sk_0"]);

    expect(r.loads.length).toBe(5);
    expect(sum(r)).toBe(5);
    expect(r.skipped.map((s) => s.name)).toEqual(["deploy-runbook"]);
    expect(r.spend).toBe(5 * 900);
  });

  /* State A: the silent one. A version-0 skill in the always-on set appeared
     on no line, the lines said 5 against a figure of 4, and the token meter
     disagreed with the token column. */
  it("with a version-0 skill in the always-on set, which it also names", () => {
    const library = [
      ...ordinary,
      skill({ id: "sk_0", name: "deploy-runbook", version: 0, alwaysOn: true }),
    ];
    const r = at(library);

    expect(r.loads.length).toBe(4);
    expect(sum(r)).toBe(4);
    expect(lines(r)).toEqual([2, 2, 0]);
    expect(r.skipped.map((s) => s.name)).toEqual(["deploy-runbook"]);
    // The meter and the token column are computed from the same set.
    expect(r.spend).toBe(4 * 900);
    expect(lines(r)).toEqual([
      r.from.always.length,
      r.from.repo.length,
      r.from.named.length,
    ]);
  });

  it("with a version-0 skill in a repository's defaults", () => {
    const library = [
      ...ordinary,
      skill({ id: "sk_0", name: "deploy-runbook", version: 0, defaultIn: ["acme/web"] }),
    ];
    const r = at(library);
    expect(r.loads.length).toBe(4);
    expect(sum(r)).toBe(4);
    expect(r.skipped).toHaveLength(1);
  });

  /* A skill a switch supplies and the figure excludes is on `skipped`, not
     on "N more already included" — that label claims the skill arrives. */
  it("does not call a skipped skill one that is already included", () => {
    const library = [
      ...ordinary,
      skill({ id: "sk_0", name: "deploy-runbook", version: 0, alwaysOn: true }),
    ];
    const r = at(library, ["sk_0"]);
    expect(r.dupes).toEqual([]);
    expect(r.skipped.map((s) => s.id)).toEqual(["sk_0"]);
    expect(sum(r)).toBe(r.loads.length);
  });
});

describe("two skills of one name", () => {
  /* One folder of a name can exist on the worker, and the agent answers to the
     name — so neither is sent, and the count has to say so or it is a figure
     of N that delivers N−1. */
  it("are both out of the figure, out of the lines, and named", () => {
    const library = [
      ...ordinary,
      skill({ id: "sk_6", name: "dataviz", path: "d/platform", alwaysOn: true }),
    ];
    const r = at(library);

    expect(r.clashes).toHaveLength(1);
    expect(r.clashes[0].map((s) => s.id).sort()).toEqual(["sk_4", "sk_6"]);
    expect(r.loads.map((s) => s.name)).not.toContain("dataviz");
    expect(r.loads.length).toBe(3);
    expect(sum(r)).toBe(3);
    expect(r.spend).toBe(3 * 900);
  });

  it("are one clash when a tick introduces the second", () => {
    const library = [...ordinary, skill({ id: "sk_6", name: "dataviz", path: "d/platform" })];
    const r = at(library, ["sk_6"]);
    expect(r.clashes).toHaveLength(1);
    expect(sum(r)).toBe(r.loads.length);
    expect(r.loads.length).toBe(3);
  });

  it("are no clash when only one of them is in the set", () => {
    const library = [...ordinary, skill({ id: "sk_6", name: "dataviz", path: "d/platform" })];
    const r = at(library);
    expect(r.clashes).toEqual([]);
    expect(r.loads.length).toBe(4);
  });
});
