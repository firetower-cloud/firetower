/**
 * Every schedules destination scrolls.
 *
 * **All four of them wrapped their content in `className="scroll"`, and that
 * class does not exist** — not in `styles.css`, not in `globals.css`, and not
 * as a Tailwind utility. It reads exactly like the thing it was meant to be,
 * it typechecks, and it renders: the element is simply a plain `div`. The
 * destination host is `overflow-hidden`, so what the page did instead of
 * scrolling was get cut off at the window's edge — with five schedules and
 * the examples under them, the examples were unreachable.
 *
 * Source-level, like `components/ui/reuse.test.ts`, and for the same reason:
 * the question is which classes a file asks for, and a test that runs in two
 * seconds is one people keep. A rendered check would not have caught it
 * either, because the markup was never wrong — only inert.
 *
 * The rule is the product's: **the page body scrolls, the chrome does not.**
 * `Dashboard`, `TasksPage`, `Account` and `Configuration` all say so in the
 * same words, and these now say it in those words too rather than in words of
 * their own.
 */
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The classes an element needs to be the scroller of a destination. */
const SCROLLS = /className="scroll-slim[^"]*overflow-y-auto/;

/**
 * The full-height surfaces: a screen somebody lands on, which owns the whole
 * of the sheet and can be taller than it.
 *
 * Named rather than discovered, so adding a fifth is a deliberate act that
 * includes a line here. `NewSchedule` is not among them — it is a dialog over
 * one of these and scrolls its own scrim.
 */
const DESTINATIONS = [
  "SchedulesPage.tsx",
  "ScheduleDetail.tsx",
  "Review.tsx",
];

describe("the schedules destinations", () => {
  for (const file of DESTINATIONS) {
    test(`${file} scrolls its own body`, () => {
      const text = readFileSync(join(HERE, file), "utf8");
      expect(text).toMatch(SCROLLS);
    });
  }

  /**
   * **The mistake itself, anywhere in the app.** It was made four times in
   * one feature, which is what a plausible-looking name does: nobody looks a
   * second time at a `div` that says `scroll`.
   */
  test("nothing asks for a class called `scroll`", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "generated") walk(path);
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const text = readFileSync(path, "utf8");
          // The whole class list being the word, which is the inert case.
          // `scroll-slim` and `overflow-y-scroll` are real and are not this.
          if (/className="scroll"/.test(text)) offenders.push(path.slice(ROOT.length));
        }
      }
    };
    walk(ROOT);
    expect(offenders).toEqual([]);
  });
});
