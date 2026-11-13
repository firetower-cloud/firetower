/**
 * Every stage the connect door can be in has to draw something.
 *
 * One of them did not. `onIn` set `{ at: "joining" }` — the moment between a
 * successful sign-in and the window handing over to the app — and no branch
 * rendered it, so the card drew empty. Invisible for as long as the window
 * really did hand over, and permanent the moment it did not: `remember()`
 * announced the new row before the token reached memory, so the window kept
 * drawing that server's door, React kept the same `Connect` mounted for it,
 * and `at` had not changed so no effect reran. A title bar over an empty
 * window until the app was restarted.
 *
 * Asserted against the source rather than by rendering, because reaching
 * `joining` needs a sign-in to have happened and these tests render to a
 * string. The invariant is the one worth holding: a stage that can be set
 * must have a case that draws it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./Connect.tsx", import.meta.url), "utf8");

/** The names in `type Stage = …`. */
const declared = [...source.matchAll(/\{\s*at:\s*"([a-z]+)"/g)].map((m) => m[1]);
/** The names a `{stage.at === "…" && (` guard draws. */
const drawn = [...source.matchAll(/stage\.at === "([a-z]+)"/g)].map((m) => m[1]);

describe("the connect door's stages", () => {
  it("found them, so this test is measuring something", () => {
    expect(new Set(declared).size).toBeGreaterThanOrEqual(6);
    expect(drawn.length).toBeGreaterThanOrEqual(6);
  });

  it("draws every one of them, including the one after a sign-in", () => {
    for (const stage of new Set(declared)) {
      expect(drawn, `the "${stage}" stage draws nothing`).toContain(stage);
    }
    expect(drawn).toContain("joining");
  });
});
