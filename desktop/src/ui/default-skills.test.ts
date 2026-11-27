import { describe, expect, it } from "vitest";
import { defaultSkills } from "./StartComposer";

/**
 * What a new workspace opens with.
 *
 * **Always-on, and nothing else.** Per-repository assignment is deleted: what
 * a repository needs, a repository *commits* — reviewed in a pull request,
 * versioned with the code, and working in plain Claude Code, where whoever can
 * merge to `main` decides. That is a rule nobody has to be taught, and it
 * replaces one that required a screen to explain it.
 *
 * These tests used to pin the opposite, and the history is worth keeping: the
 * rule was one line and it was wrong in two places at once, because both
 * callers read `defaultIn` as repository **ids** when the server sends slugs.
 * Nothing threw and nothing was logged, so a default that silently failed to
 * apply looked exactly like one that was never set. The replacement cannot
 * fail that way, because there is nothing left to match.
 */
const skill = (id: string, over: { alwaysOn?: boolean; defaultIn?: string[] } = {}) => ({
  id,
  alwaysOn: false,
  defaultIn: [],
  ...over,
});

const LIBRARY = [
  skill("sk_always", { alwaysOn: true }),
  skill("sk_also_always", { alwaysOn: true }),
  skill("sk_web", { defaultIn: ["acme/web"] }),
  skill("sk_both", { defaultIn: ["acme/web", "acme/api"] }),
  skill("sk_none"),
];

const web = { id: "r_web", slug: "acme/web" };
const api = { id: "r_api", slug: "acme/api" };

const ids = (library: typeof LIBRARY, checkouts: { slug: string }[]) =>
  defaultSkills(library, checkouts).map((s) => s.id);

describe("what a new workspace opens with", () => {
  it("is this person's always-on bundles", () => {
    expect(ids(LIBRARY, [web])).toEqual(["sk_always", "sk_also_always"]);
  });

  it("does not depend on what is being checked out", () => {
    // The property the old rule could not have: one answer, whatever the
    // repositories. A default somebody has to predict is a default they
    // cannot rely on.
    expect(ids(LIBRARY, [])).toEqual(ids(LIBRARY, [web]));
    expect(ids(LIBRARY, [web])).toEqual(ids(LIBRARY, [web, api]));
  });

  it("leaves a repository default behind, deliberately", () => {
    // `sk_web` is marked for `acme/web` and `acme/web` is checked out. It is
    // still not loaded: those rows are no longer read, and a repository that
    // needs tooling commits it.
    expect(ids(LIBRARY, [web])).not.toContain("sk_web");
    expect(ids(LIBRARY, [web, api])).not.toContain("sk_both");
  });

  it("keeps the library's order, so the picker opens the way the list reads", () => {
    const shuffled = [...LIBRARY].reverse();
    expect(ids(shuffled, [web])).toEqual(["sk_also_always", "sk_always"]);
  });

  it("is nothing when nothing is always on", () => {
    expect(ids([skill("sk_none"), skill("sk_web", { defaultIn: ["acme/web"] })], [web])).toEqual([]);
  });
});
