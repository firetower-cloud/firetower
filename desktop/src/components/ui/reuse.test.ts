/**
 * Every component has a user, and no screen re-implements one.
 *
 * **Three components have now been found complete and unreferenced.**
 * `Palette.tsx` had never once been on screen — a tooltip promised a command
 * palette and nothing rendered one. `Brand.tsx` had diverged far enough that
 * web could not draw a GitLab mark. And `Segmented.tsx` sat exported and
 * imported by nothing while three screens hand-rolled it, until the one in
 * the profile menu drifted far enough that somebody noticed it did not match.
 *
 * The usage counts in `components.html` cannot catch this: they are measured
 * by walking *the prototype*. A component reads as perfectly healthy there —
 * used on six screens of the drawing — while the app imports it zero times.
 * Those counts answer "is this used in the design", and this answers "is this
 * used in the product".
 *
 * Source-level rather than a browser check, because the question is about
 * imports rather than pixels and a test that runs in two seconds is one
 * people actually keep.
 */
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

/* **`fileURLToPath`, never `.pathname`.** A file URL's pathname is
   `/C:/src/...` on Windows, and `join` turns that into `C:\C:\src\...` —
   a doubled drive letter, and an `ENOENT` on `scandir` that only ever
   appears on the Windows runner. The other two tests that read a file from
   disk here already do it this way. */
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Every `.ts`/`.tsx` under `src`, read once. */
function sources(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "generated") walk(path);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        /* Posix separators whatever the runner is. The sets below are
           written with `/`, and on Windows these arrive as `\` — which made
           every recorded offender read as a new one. */
        out.push({
          path: path.slice(ROOT.length).split(sep).join("/"),
          text: readFileSync(path, "utf8"),
        });
      }
    }
  };
  walk(ROOT);
  return out;
}

const FILES = sources();

/**
 * **A ratchet, not a wish.** Both of these are recorded as the exact set of
 * offenders rather than as "none", because the set is not empty today and a
 * test that fails on arrival is a test somebody deletes. Asserting the exact
 * set means a new offender fails immediately, and fixing one fails too until
 * the list is shortened — so the debt can only go down, and it is counted
 * where somebody will read it rather than in a comment.
 */
const UNUSED: string[] = [];

describe("every component is reachable from the product", () => {
  const components = readdirSync(join(ROOT, "components/ui"))
    .filter((f) => /^[A-Z].*\.tsx$/.test(f))
    .map((f) => f.replace(/\.tsx$/, ""));

  test("the components nothing imports are exactly the ones we know about", () => {
    const orphans = components.filter((name) => {
      const users = FILES.filter(
        (f) => !f.path.endsWith(`components/ui/${name}.tsx`) && !f.path.endsWith("components/ui/index.ts"),
      ).filter((f) => new RegExp(`\\b${name}\\b`).test(f.text));
      return users.length === 0;
    });
    /* **Empty, and it took four passes to get here.** `Segmented`,
       `IconButton` and `Badge` were each complete, exported and reached by
       nothing while screens hand-rolled their classes; `Palette` had never
       been on screen at all. The list is the record of that. */
    expect(orphans.sort()).toEqual(UNUSED);
  });
});

describe("no screen re-implements a component that exists", () => {
  /**
   * A primitive's distinguishing class belongs inside the one file that owns
   * it. A `.track` anywhere else was a second segmented control; the same
   * will be true of the next one.
   */
  const OWNED: [string, string, string[]][] = [
    /* The one the user reported. Nothing writes `.seg` by hand any more. */
    ["seg", "components/ui/Segmented.tsx", []],
    /* Was `["ui/Connect.tsx"]`, which drew a *server's* mark with a
       *person's* class. Same disc, different rule — `markOf` takes two
       letters so two Firetowers sharing a first letter stay apart, and
       `monogram` takes one because the row says the name beside it. */
    ["face", "components/ui/Avatar.tsx", []],
    /* Was nine screens. `IconButton` gained a `hint` — a tooltip that differs
       from the name — and an `onClick` that can see its event, which is most
       of why they were hand-rolled. */
    ["gbtn", "components/ui/IconButton.tsx", []],
    ["ttag", "components/ui/Badge.tsx", []],
  ];

  test.each(OWNED)("`.%s` is written outside %s in exactly the known places", (cls, owner, known) => {
    const elsewhere = FILES.filter((f) => !f.path.endsWith(owner))
      /* The class as it is actually written in markup, not as a word in
         prose — `className="seg ..."` or inside a template. */
      .filter((f) => new RegExp(`className=[{"\`][^"\`}]*\\b${cls}\\b`).test(f.text))
      .map((f) => f.path.replace(/^\/?/, ""))
      .sort();
    expect([...new Set(elsewhere)]).toEqual([...known].sort());
  });
});

/**
 * Every token the stylesheets define is used by something.
 *
 * **This is the third thing found complete and unreferenced**, after the
 * components. `--color-scrim` was created with the overlay taxonomy, shipped
 * in `globals.css`, and reached exactly one file — so thirteen sheets went on
 * drawing their own `bg-ground/40` wash and the one the design specified sat
 * there being correct and unused. A design can land in `docs/` and in the
 * token sheet and still never reach the product, and nothing was watching the
 * last step.
 *
 * A reference counts from anywhere but the definition: a Tailwind utility in
 * a component, a `var()` in a component, or a `var()` in a rule a component
 * wears. What this catches is a token with *no* user, which is what
 * `--color-scrim` was on the day it was written.
 */
describe("every token is used by something", () => {
  const SHEETS = ["globals.css", "styles.css"].map((f) => readFileSync(join(ROOT, f), "utf8"));
  const ALL = [...FILES.map((f) => f.text), ...SHEETS].join("\n");

  /** The tokens, by the name a utility would use: `--color-scrim` → `scrim`. */
  /* **`styles.css` only.** `globals.css` is byte-shared with the web client,
     so a token dead *here* may be alive there, and criterion 6 holds web
     still — whether `--radius` and `--color-ember-soft` should go is a
     question for whoever owns both, not one this file can answer. The desk's
     own sheet has no such excuse. */
  const tokens = [
    ...new Set([...SHEETS[1].matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1])),
  ].sort();

  /* Tokens a stylesheet owns outright — a step, a duration, an easing. They
     are read by rules rather than by class names, and a `var()` hit covers
     them. Listed so the rule stays about *colour and type*, which is where
     a dead token means a design that did not land. */
  const used = (token: string) => {
    if (ALL.includes(`var(${token})`)) return true;
    /* Tailwind v4's arbitrary value: `w-(--panel)`, `h-(--row)`. */
    if (ALL.includes(`(${token})`)) return true;
    /* **A modifier is used when its tier is.** `--text-ui--line-height` is
       read by Tailwind when somebody writes `text-ui`; it is never named. */
    const tier = token.match(/^(--text-[\w-]+?)--(line-height|letter-spacing|font-weight)$/);
    if (tier) return used(tier[1]);
    /* `--color-scrim` is worn as `bg-scrim`, `text-scrim`, `border-scrim`… */
    const bare = token.replace(/^--(color|text|font|radius|shadow|dur|ease)-/, "");
    return new RegExp(`[\\s"'\`:{-]((?:bg|text|border|fill|stroke|ring|from|to|via|shadow|decoration|outline|divide|accent|caret|font|rounded)-)?${bare}\\b`).test(
      FILES.map((f) => f.text).join("\n"),
    );
  };

  test("no token is defined and then never reached", () => {
    expect(tokens.filter((t) => !used(t))).toEqual([]);
  });
});

/**
 * An optional chain that stops one link short of the thing it is reading.
 *
 * **Three white screens came from this, on three different days.** The skill
 * review read `q.data?.files` and called `.map` on it; the account sheet read
 * `current.data?.limits` and called `.find`; the team rail read a session's
 * `name` and called `.lastIndexOf`. Each time `?.` guarded the *response* and
 * not the field, so an answer that arrived but was not the expected shape —
 * the mock's catch-all `[]`, a server one version out, a proxy — sailed past
 * the guard and threw one level in.
 *
 * Scoped to `.data?.`, which is where a value crosses from the server into
 * this code. Inside the client a shape is ours to guarantee: `place.runs` is
 * set by `group()` in the same module, so chaining it would be noise. The
 * whole-tree version of this rule was measured first — fifteen hits, eleven
 * of them this one boundary — because a check with a bad signal-to-noise
 * ratio gets switched off, which is worse than no check.
 */
describe("a response is guarded at the field, not just at the response", () => {
  test("no `.data?.x.y` — the second link is unguarded", () => {
    const risky = FILES.flatMap((f) =>
      [...f.text.matchAll(/\.data\?\.(\w+)\.\w+/g)].map((m) => `${f.path}: .data?.${m[1]}.…`),
    );
    expect(risky).toEqual([]);
  });
});
