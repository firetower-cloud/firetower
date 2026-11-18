/**
 * What the review draws, per state.
 *
 * Resolved colours are asserted in a browser by
 * `scripts/shoot-import-review.mjs`, which is where a hue can be read out of a
 * running document. What is here is the half that needs no browser: which rows
 * get a field panel, whether the primary is available, and **whether a
 * sentence the screen puts on the page is one the server produced**.
 *
 * That last one is why this file exists in its current form. The first version
 * asserted that amber appeared `> 0` times and that twenty marker strings were
 * present — assertions that could not fail, over fixtures whose every sentence
 * was invented. The specimens are generated now (`import-plans.ts`), and the
 * tests below compare rendered text against them rather than against a literal
 * typed here.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ImportProfiles } from "./ImportProfiles";
import { PLANS, REFUSALS } from "./import-plans";
import { conditionOf, labelOf } from "./import-plan";
import type { ImportPlan } from "~/api/generated/model";

const ALL_NEW = PLANS["all-new"]!;
const MIXED = PLANS.mixed!;
const ALL_BLOCKED = PLANS["all-blocked"]!;
const RENAME = PLANS.rename!;
const NEAR_MATCH = PLANS["near-match"]!;
const LARGE = PLANS.large!;
const SAME_NAME = PLANS["same-name"]!;
const SAME_KEY = PLANS["same-key"]!;
const BAD_SETTING = PLANS["bad-setting"]!;
const NOTHING = PLANS["nothing-to-import"]!;
const AT_THE_ROOT = PLANS["at-the-root"]!;

const nothing = () => {};
const draw = (plan: ImportPlan, refused: string | null = null) =>
  renderToStaticMarkup(
    <ImportProfiles plan={plan} refused={refused} onClose={nothing} onApply={nothing} />,
  );

const times = (html: string, needle: string) => html.split(needle).length - 1;

/** The markup with its tags taken out, which is what somebody reads. */
const readable = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/g, "/")
    .replace(/\s+/g, " ");

/* ── The sentences are the server's ─────────────────────────────────────── */

describe("every sentence on the screen came from the plan", () => {
  /* The failure this guards is specific and it already happened: seven states
     of plausible, well-edited copy that the product never printed, under a
     hundred and twenty assertions that all passed because each checked shape.
     A rendered sentence is now compared against the specimen it must have come
     from, and the specimen is generated from the planner. */
  it.each(Object.entries(PLANS))("%s draws its problems verbatim", (_name, plan) => {
    const said = readable(draw(plan));
    let checked = 0;
    for (const e of plan.entries) {
      if (e.outcome.kind === "blocked")
        for (const p of e.outcome.problems) {
          expect(said).toContain(readable(p.says));
          expect(said).toContain(`${p.path}:${p.line}`);
          checked++;
        }
      if (e.outcome.kind === "candidate")
        for (const p of e.outcome.proposals) {
          expect(said).toContain(readable(p.says));
          checked++;
        }
      for (const w of e.warnings) {
        expect(said).toContain(readable(w.says));
        checked++;
      }
    }
    expect(checked).toBe(
      plan.entries.reduce(
        (n, e) =>
          n +
          e.warnings.length +
          (e.outcome.kind === "blocked" ? e.outcome.problems.length : 0) +
          (e.outcome.kind === "candidate" ? e.outcome.proposals.length : 0),
        0,
      ),
    );
  });

  it.each(Object.entries(PLANS).filter(([, p]) => p.whyNot.length > 0))(
    "%s draws its whyNot verbatim",
    (_name, plan) => {
      const said = readable(draw(plan));
      for (const why of plan.whyNot) expect(said).toContain(readable(why));
    },
  );

  it("draws a refusal verbatim, and draws no list with it", () => {
    const says = REFUSALS["too-many-files"]!;
    const html = draw(MIXED, says);
    expect(readable(html)).toContain(readable(says));
    expect(html).not.toContain('class="imp"');
  });
});

/* ── The banner says what is wrong ──────────────────────────────────────── */

describe("the blocked banner", () => {
  it("leads with the condition rather than with the word blocked", () => {
    const html = draw(MIXED);
    const head = html.slice(html.indexOf("<h3>") + 4, html.indexOf("</h3>"));
    const one = MIXED.entries.find((e) => e.outcome.kind === "blocked")!;
    expect(readable(head)).toBe(`${labelOf(one)}: ${readable(conditionOf(one)!)}`);
    expect(head).not.toMatch(/is blocked/);
  });

  /* The body carries the all-or-nothing consequence, which is a different
     fact. What it may not do is repeat the heading back. */
  it("does not repeat its own heading in its body", () => {
    const html = draw(MIXED);
    const head = readable(html.slice(html.indexOf("<h3>") + 4, html.indexOf("</h3>")));
    const banner = readable(html.slice(html.indexOf('class="review"'), html.indexOf('class="imp"')));
    expect(banner.split(head)).toHaveLength(2);
  });
});

/* ── Colour ─────────────────────────────────────────────────────────────── */

describe("colour discipline", () => {
  it.each(Object.entries(PLANS))("%s spends no ember", (_name, plan) => {
    expect(draw(plan)).not.toMatch(/ember/);
  });

  /* The old version of this asserted `ambers.length > 0`, which no change
     could have failed. What matters is *which* elements wear it. */
  it("spends amber on a duplicate-name warning and on nothing else", () => {
    const html = draw(SAME_NAME);
    expect(times(html, 'data-warn="duplicate-name"')).toBe(2);
    expect(times(html, 'data-warn="other"')).toBe(0);
    // Each amber warning carries the amber rule; no other element does.
    expect(times(html, "border-amber-soft")).toBe(2);
  });

  /* A setting the plan cannot check, because the profile pins no engine. The
     first warning in the product that is not about a duplicate name, and so
     the first real test of the rule — it must take the neutral rule. */
  it("gives a warning that is not about a duplicate name the neutral rule", () => {
    const warned = BAD_SETTING.entries.flatMap((e) => e.warnings);
    expect(warned).toHaveLength(1);
    expect(warned[0]!.key).toBe("settings.effort");

    const html = draw(BAD_SETTING);
    expect(times(html, 'data-warn="other"')).toBe(1);
    expect(times(html, 'data-warn="duplicate-name"')).toBe(0);
    expect(times(html, "border-amber-soft")).toBe(0);
  });

  /* A reset is the one thing in the diff wearing a colour, and a drop with no
     reset in it has no colour in its diff at all. */
  it("tints a reset row and leaves an ordinary change plain", () => {
    expect(times(draw(MIXED), 'data-c="reset"')).toBeGreaterThan(0);
    expect(draw(RENAME)).not.toContain('data-c="reset"');
    expect(draw(ALL_NEW)).not.toMatch(/amber/);
  });
});

/* ── Structure ──────────────────────────────────────────────────────────── */

describe("the field panel", () => {
  it("draws all sixteen fields, unchanged ones included", () => {
    const html = draw(MIXED);
    expect(times(html, 'data-c="')).toBe(20); // 15 leaves + settings + its 4
    expect(times(html, 'data-c="unchanged"')).toBeGreaterThan(13);
  });

  /* `PlanBlocked` carries no diff, so there is nothing to show — the
     prototype's finding about the unparseable file, true of every blocked row. */
  it("gives a blocked entry no field panel at all", () => {
    expect(draw(ALL_BLOCKED)).not.toContain("dsheet");
  });

  it("gives a row with nothing to expand no expander", () => {
    expect(draw(ALL_BLOCKED)).not.toContain("aria-expanded");
    expect(draw(MIXED)).toContain("aria-expanded");
  });

  /* A file that never parsed has no `name`, so the row shows its folder. */
  it("falls back to the folder when the file gave no name", () => {
    const nameless = ALL_BLOCKED.entries.find((e) => e.name == null)!;
    expect(readable(draw(ALL_BLOCKED))).toContain(nameless.key);
  });

  /* Dropped without its folder: no key, no name, and the row had no title. */
  it("titles a PROFILE.md dropped without its folder", () => {
    const html = draw(AT_THE_ROOT);
    const title = html.slice(html.indexOf('class="text-title'), html.indexOf("</span>", html.indexOf('class="text-title')));
    expect(readable(title)).toContain("PROFILE.md");
  });

  /* What it is for, where the plan carries it — only an overwrite and a
     rename do, because `does` lives in the diff and nothing else has one. */
  it("draws the description on a row whose plan carries one", () => {
    const said = readable(draw(MIXED));
    const designer = MIXED.entries.find((e) => e.key === "designer")!;
    const text = designer.outcome.kind === "overwrite"
      ? designer.outcome.diff.find((f) => f.field === "does")!.after
      : "";
    expect(text.length).toBeGreaterThan(0);
    expect(said).toContain(readable(text));
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

  /* #349 in a new place: a dead button with no sentence beside it. The server
     supplies the reason now — `appliable` is derived from `why_not`, so a
     reason-less refusal cannot be built — and this asserts the screen draws
     it. The floor underneath, for a plan that somehow arrives without one, is
     asserted in `import-plan.test.ts`. */
  /* The bounds come off `plan.limits`, so a client cannot drift from them. */
  it("names every bound when a drop is refused", () => {
    const html = draw(MIXED, REFUSALS["too-many-files"]!);
    const said = readable(html);
    expect(said).toContain(`${MIXED.limits.files} files`);
    expect(said).toContain(`${Math.round(MIXED.limits.totalBytes / 1024 / 1024)} MB in total`);
  });

  it("never appears dead without a sentence", () => {
    const html = draw(NOTHING);
    expect(html).toMatch(/<button disabled=""[^>]*class="btn primary"/);
    const foot = readable(html.slice(html.indexOf('class="formfoot"')));
    expect(foot).toContain(readable(NOTHING.whyNot[0]!));
    expect(foot).toContain("PROFILE.md");
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
    expect(html).toContain("Copy the errors");
  });
});

describe("a candidate", () => {
  it("offers two answers and presses neither", () => {
    const html = draw(NEAR_MATCH);
    expect(times(html, 'role="radio"')).toBe(2);
    expect(html).toContain("A new profile");
    expect(html).not.toContain('role="radio" aria-checked="true"');
  });
});

describe("a rename", () => {
  it("reads as a rename rather than as a create", () => {
    const html = draw(RENAME);
    expect(html).toContain("Renames <b");
    expect(html).toContain("will rename");
    expect(html).not.toContain("Creates <b");
  });

  it("still draws all sixteen fields underneath it", () => {
    expect(times(draw(RENAME), 'data-c="')).toBe(20);
  });
});

describe("two bundles of one key", () => {
  /* The entry's identity is its path, so the two rows are two rows. Keyed by
     `key`, React would collapse them and one tick would drive both. */
  it("draws both, and ticks them independently", () => {
    const html = draw(SAME_KEY);
    expect(times(html, 'class="imp"')).toBe(2);
    expect(times(html, 'aria-checked="true"')).toBe(2);
    for (const e of SAME_KEY.entries) expect(html).toContain(e.path);
  });
});

describe("files that were part of no profile", () => {
  it("says how many, and what counts as one", () => {
    const html = draw(MIXED);
    expect(html).toContain(`${MIXED.ignored.length} files were not read.`);
    expect(html).toContain("A profile is a folder with a");
  });

  it("is drawn with no severity of its own", () => {
    const html = draw(MIXED);
    const note = html.slice(html.indexOf('class="note2"'), html.indexOf('class="formfoot"'));
    expect(note).not.toMatch(/amber|brick/);
    expect(draw(ALL_NEW)).not.toContain("note2");
  });
});

describe("the list", () => {
  it("draws filter pills only once there is enough list to narrow", () => {
    expect(draw(LARGE)).toContain("Narrow the list");
    expect(draw(MIXED)).not.toContain("Narrow the list");
  });

  it("keeps the plan's order in the markup", () => {
    const html = draw(LARGE);
    const drawn = LARGE.entries.map((e) => html.indexOf(e.path));
    expect(drawn).toEqual([...drawn].sort((a, b) => a - b));
  });
});
