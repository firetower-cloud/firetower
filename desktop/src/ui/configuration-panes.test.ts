/**
 * Every pane in the index has something to draw.
 *
 * `Configuration`'s switch takes a `string`, so it needs a `default` arm —
 * and that arm returns Repositories, which is `paneAt`'s own fallback and
 * therefore indistinguishable from a pane working. **A pane added to `PANES`
 * without a component would silently draw Repositories for ever**, under its
 * own name in the rail panel, with nothing anywhere saying it had not been
 * wired up.
 *
 * So the index and the switch are checked against each other. Source-level,
 * like `reuse.test.ts`: the question is about which cases exist rather than
 * about pixels, and a test that runs in milliseconds is one people keep.
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PANES, SETTINGS } from "~/ui/config/panes";

/* `fileURLToPath`, never `.pathname` — a file URL's pathname is `/C:/src/…`
   on Windows, which is not a path any `readFileSync` there will take. */
const SOURCE = readFileSync(fileURLToPath(new URL("./Configuration.tsx", import.meta.url)), "utf8");

/** The pane names the switch actually answers to. */
const drawn = [...SOURCE.matchAll(/case "([\w-]+)":/g)].map((m) => m[1]).sort();

/**
 * Every pane either index lists, which is every pane that can be navigated to.
 *
 * Deduplicated, because the Vault is in both: `PANES` is the whole
 * configuration index and `SETTINGS` is the subset Settings itself owns.
 */
const listed = [
  ...new Set([...PANES, ...SETTINGS].flatMap((g) => g.items.map((i) => i.at))),
].sort();

describe("the configuration index and the pane it draws", () => {
  test("every pane in an index is named by the switch", () => {
    expect(listed.filter((at) => !drawn.includes(at))).toEqual([]);
  });

  /* And the other way: a case for a pane no index lists is a screen nobody
     can reach, which is the shape `reuse.test.ts` was written about. */
  test("the switch names no pane an index does not list", () => {
    expect(drawn.filter((at) => !listed.includes(at))).toEqual([]);
  });

  /**
   * **The paired assertion.** Both sets above are empty if the regex matches
   * nothing — a rename of `case` syntax, a switch turned into a lookup table
   * — so the check would pass while reading no cases at all.
   */
  test("found the switch it is checking", () => {
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn).toEqual(listed);
  });
});
