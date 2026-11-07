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
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;

/** Every `.ts`/`.tsx` under `src`, read once. */
function sources(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "generated") walk(path);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push({ path: path.slice(ROOT.length), text: readFileSync(path, "utf8") });
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
const UNUSED = ["Badge", "IconButton"];

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
    /* `Badge` and `IconButton` are the two left. Nine screens write `.gbtn`
       by hand where `IconButton` exists, which is the Segmented story again
       and the next pass. */
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
    ["face", "components/ui/Avatar.tsx", ["ui/Connect.tsx"]],
    [
      "gbtn",
      "components/ui/IconButton.tsx",
      [
        "ui/Connect.tsx",
        "ui/Inspector.tsx",
        "ui/TasksPage.tsx",
        "ui/Workbench.tsx",
        "ui/config/Directories.tsx",
        "ui/config/GitHosts.tsx",
        "ui/config/Roles.tsx",
        "ui/config/Secrets.tsx",
        "ui/config/Trackers.tsx",
      ],
    ],
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
