import { describe, expect, it } from "vitest";
import { defaultSkills } from "./StartComposer";

/**
 * Which skills a new workspace starts with.
 *
 * The rule is one line and it was wrong in two places at once — the composer
 * and the schedule sheet both read `defaultIn` as repository **ids**. It is
 * slugs: the server builds it as `array_agg(r.slug)` over `skill_defaults`
 * joined to `repos`, so `acme/web` comes back where `r_web` was being
 * compared. The two can never be equal, so "use by default in this
 * repository" quietly did nothing and only the always-on skills survived.
 *
 * Nothing threw and nothing was logged, which is why this is pinned rather
 * than left to the screen: a default that silently fails to apply looks
 * exactly like a default that was never set.
 */
const skill = (id: string, over: { alwaysOn?: boolean; defaultIn?: string[] } = {}) => ({
  id,
  alwaysOn: false,
  defaultIn: [],
  ...over,
});

const LIBRARY = [
  skill("sk_always", { alwaysOn: true }),
  skill("sk_web", { defaultIn: ["acme/web"] }),
  skill("sk_api", { defaultIn: ["acme/api"] }),
  skill("sk_both", { defaultIn: ["acme/web", "acme/api"] }),
  skill("sk_none"),
];

/** A checked-out repository carries both, which is how the id got used. */
const web = { id: "r_web", slug: "acme/web" };
const api = { id: "r_api", slug: "acme/api" };

/** What the two callers build out of it: the ids they start the work with. */
const ids = (library: typeof LIBRARY, checkouts: { slug: string }[]) =>
  defaultSkills(library, checkouts).map((s) => s.id);

describe("the skills a new workspace starts with", () => {
  it("includes one defaulted in a repository being checked out", () => {
    // The report. Before the fix this was ["sk_always"] — the repository
    // default was dropped and nothing said so.
    expect(ids(LIBRARY, [web])).toEqual(["sk_always", "sk_web", "sk_both"]);
  });

  it("matches on the slug, never on the id the checkout also carries", () => {
    // `defaultIn` naming the id rather than the slug is the mistake restated:
    // it must not match, or the fix is matching on whichever field is handy.
    const byId = [skill("sk_byid", { defaultIn: ["r_web"] })];
    expect(ids(byId, [web])).toEqual([]);
  });

  it("takes the union over every repository checked out, once each", () => {
    expect(ids(LIBRARY, [web, api])).toEqual([
      "sk_always",
      "sk_web",
      "sk_api",
      "sk_both",
    ]);
  });

  it("leaves a default for a repository that is not checked out", () => {
    expect(ids(LIBRARY, [api])).toEqual(["sk_always", "sk_api", "sk_both"]);
  });

  it("is the always-on set alone when nothing is checked out", () => {
    expect(ids(LIBRARY, [])).toEqual(["sk_always"]);
  });

  it("keeps an always-on skill once, even when it is also a repository default", () => {
    const both = [skill("sk_1", { alwaysOn: true, defaultIn: ["acme/web"] })];
    expect(ids(both, [web])).toEqual(["sk_1"]);
  });
});
