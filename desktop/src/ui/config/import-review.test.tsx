/**
 * What the review actually draws, per state.
 *
 * The resolved colours are asserted in the browser by
 * `scripts/shoot-import-review.mjs`, which is where a hue can be read out of a
 * running document. What is here is the half that does not need one: which
 * rows get a field panel, how many fields are in it, whether the primary is
 * available, and whether a string the ticket names by name is on the page.
 *
 * Rendered rather than described — `renderToStaticMarkup`, the way
 * `roles-readback.test.tsx` does it, so a component that stops emitting a
 * sentence fails here rather than in a screenshot nobody re-reads.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ImportProfiles } from "./ImportProfiles";
import { ALL_BLOCKED, ALL_NEW, LARGE, MIXED, NEAR_MATCH, OVER_LIMIT, RENAME } from "./import-plans";
import type { ImportPlan } from "~/api/generated/model";

const nothing = () => {};
const draw = (plan: ImportPlan) =>
  renderToStaticMarkup(<ImportProfiles plan={plan} onClose={nothing} onApply={nothing} />);

/** Count of a substring, which is how a markup string answers "how many". */
const times = (html: string, needle: string) => html.split(needle).length - 1;

describe("the field panel", () => {
  it("draws all sixteen fields, unchanged ones included", () => {
    const html = draw(MIXED);
    /* 15 leaf rows, the `settings` header row, and its four leaves. Every one
       of them carries its own change, which is what the counts add up to. */
    expect(times(html, 'class="dr"')).toBe(20);
    expect(times(html, 'data-c="')).toBe(20);
    expect(
      times(html, 'data-c="unchanged"') +
        times(html, 'data-c="reset"') +
        times(html, 'data-c="changed"'),
    ).toBe(20);
    expect(times(html, 'data-c="reset"')).toBe(1);
    expect(times(html, 'data-c="changed"')).toBe(2);
  });

  it("marks a reset with a word as well as a tint", () => {
    expect(draw(MIXED)).toContain('class="tagr">reset<');
  });

  /* `PlanBlocked` carries no diff, so there is nothing to show — which is the
     prototype's own finding about the unparseable file, true of every blocked
     row rather than only that one. */
  it("gives a blocked entry no field panel at all", () => {
    const html = draw(ALL_BLOCKED);
    expect(html).not.toContain("dsheet");
    expect(html).toContain("The frontmatter does not parse");
  });

  it("names the file, the key, the line and which entry of a list", () => {
    const html = draw(ALL_BLOCKED);
    expect(html).toContain("delegates_to[3]");
    expect(html).toContain("profiles/engineering-manager/PROFILE.md:19");
  });

  /* A disclosure that discloses nothing is a broken control. */
  it("gives a row with nothing to expand no expander", () => {
    expect(draw(ALL_BLOCKED)).not.toContain("aria-expanded");
    expect(draw(MIXED)).toContain("aria-expanded");
  });
});

describe("the primary action", () => {
  it("is unavailable while anything is blocked, and keeps its real label", () => {
    const html = draw(MIXED);
    expect(html).toContain("Import 5 profiles");
    expect(html).not.toContain("Can't import");
    expect(html).toMatch(/<button disabled=""[^>]*class="btn primary"/);
  });

  it("is available on a drop with nothing to answer and nothing blocked", () => {
    expect(draw(ALL_NEW)).not.toMatch(/<button disabled=""[^>]*class="btn primary"/);
  });
});

describe("a blocked profile", () => {
  it("arrives ticked, so excluding it is something you do", () => {
    const html = draw(ALL_BLOCKED);
    expect(times(html, 'aria-checked="true"')).toBe(5);
    expect(html).not.toContain('aria-checked="false"');
  });

  it("arrives expanded, and offers both ways out", () => {
    const html = draw(MIXED);
    expect(html).toContain('data-state="blocked" data-open="true"');
    expect(html).toContain("Exclude Security Advisor");
    expect(html).toContain("Copy the errors");
  });
});

describe("a candidate", () => {
  it("offers two answers and presses neither", () => {
    const html = draw(NEAR_MATCH);
    expect(times(html, 'role="radio"')).toBe(2);
    expect(html).toContain("This is <b>Designer</b>");
    expect(html).toContain("A new profile");
    expect(html).not.toContain('role="radio" aria-checked="true"');
  });

  it("holds the import up until it is answered", () => {
    expect(draw(NEAR_MATCH)).toMatch(/<button disabled=""[^>]*class="btn primary"/);
  });
});

describe("a rename", () => {
  it("reads as a rename rather than as a create", () => {
    const html = draw(RENAME);
    expect(html).toContain("Renames <b");
    expect(html).toContain("will rename");
    expect(html).not.toContain("Creates <b");
  });

  /* `PlanRename`'s own reason: a rename row carrying no diff would hide the
     other fifteen fields changing underneath it. */
  it("still draws all sixteen fields underneath it", () => {
    expect(times(draw(RENAME), 'data-c="')).toBe(20);
  });
});

describe("files that were part of no profile", () => {
  it("says how many, and what counts as one", () => {
    const html = draw(MIXED);
    expect(html).toContain("2 files were not read.");
    expect(html).toContain("A profile is a folder with a");
  });

  /* Skipping a `.DS_Store` is correct behaviour, so this is information. What
     it may never be is absent. */
  it("is drawn with no severity of its own", () => {
    const html = draw(MIXED);
    const note = html.slice(html.indexOf('class="note2"'), html.indexOf('class="formfoot"'));
    expect(note).not.toMatch(/amber|brick/);
    expect(draw(ALL_NEW)).not.toContain("note2");
  });
});

describe("a drop refused whole", () => {
  it("names the limit and gives it a brick rule", () => {
    const html = draw(OVER_LIMIT);
    expect(html).toContain('data-tone="brick"');
    expect(html).toContain("The limit is 200 files, 2 MB a file and 25 MB in total.");
    expect(html).not.toContain('class="imp"');
  });
});

describe("the list", () => {
  it("draws filter pills only once there is enough list to narrow", () => {
    expect(draw(LARGE)).toContain("Narrow the list");
    expect(draw(MIXED)).not.toContain("Narrow the list");
  });

  it("keeps the plan's order in the markup", () => {
    const html = draw(LARGE);
    const at = (key: string) => html.indexOf(`profiles/${key}/PROFILE.md`);
    /* `cost-watcher` is blocked and sits late in the folder. Sorting by state
       would hoist it above seventeen creates. */
    expect(at("designer")).toBeLessThan(at("release-manager"));
    expect(at("release-manager")).toBeLessThan(at("cost-watcher"));
  });
});

describe("colour", () => {
  /* Ember answers one question — is an agent waiting on you — and nothing
     here is that question. The resolved-colour half of this is in the shoot
     script; this catches a token named in a class before it is ever drawn. */
  it.each([ALL_NEW, MIXED, ALL_BLOCKED, RENAME, NEAR_MATCH, LARGE, OVER_LIMIT])(
    "spends no ember anywhere (%#)",
    (plan) => {
      expect(draw(plan)).not.toMatch(/ember/);
    },
  );

  it("spends amber on a reset and on a warning, and nowhere else", () => {
    const html = draw(MIXED);
    /* The summary's reset clause, the banner's field name, and the warning
       rule — all three are the one meaning: read this before you accept. */
    const ambers = html.match(/amber/g) ?? [];
    expect(ambers.length).toBeGreaterThan(0);
    expect(draw(ALL_NEW)).not.toMatch(/amber/);
  });
});
