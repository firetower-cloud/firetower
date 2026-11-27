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
 *
 * The second half of this file holds a different invariant about the same
 * stages, for the same reason: **how many ways there are into `where`.**
 * `#/connect` was gated as the way a served page could reach the
 * address question, and it was one of five — the other four are back buttons,
 * and driving one of them attached a second Firetower and wrote its registry
 * row. Gating a route is not gating a flow. So the rule is that there is
 * exactly one place that sets that stage, and everything else goes through
 * it; a fifth screen can still be added, but it cannot get its own door.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./Connect.tsx", import.meta.url), "utf8");
/** The only thing that mounts this door, and so the only thing that gates it. */
const window_ = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");

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

describe("the way back to the address question", () => {
  /* **One binding, four readers.** The count is the assertion: four screens
     offer a way back, and if a fifth is added with its own `setStage` the
     `fixed` case stops holding for it and nothing else would notice. */
  it("is set in exactly one place", () => {
    const sets = [...source.matchAll(/setStage\(\{\s*at:\s*"where"\s*\}\)/g)].length;
    expect(sets).toBe(1);
  });

  it("is what every screen that offers one is handed", () => {
    const handed = [...source.matchAll(/onBack=\{back\}/g)].length;
    expect(handed).toBe(4);
    // And nothing bypasses it with a literal of its own.
    expect(source).not.toMatch(/onBack=\{\(\) =>/);
  });

  /* The binding itself, in one line, so that what `fixed` means is readable
     without following it: no back button at all where the address is the one
     this page was served from. */
  it("is withheld entirely when the address is fixed", () => {
    expect(source).toContain("const back = fixed ? undefined : () => setStage({ at: \"where\" });");
  });

  /* And each screen draws it conditionally rather than rendering a button
     wired to `undefined`, which would look like a control and do nothing. */
  it("is drawn only where it exists", () => {
    expect([...source.matchAll(/\{onBack && /g)].length).toBe(3);
    expect(source).toContain('backLabel={back ? "Use a different address" : undefined}');
  });
});

/**
 * And the caller, because gating the door is not gating the thing that opens it.
 *
 * `fixed` can be perfectly correct inside `Connect` and do nothing at all if
 * the one component that mounts it stops passing it — which is the same
 * failure as `bodyFor` being exported, tested and re-derived inline by the
 * window, and as the `#/connect` route being shut while four back buttons
 * were not. So the call sites are counted here rather than trusted.
 */
describe("the window, which is the only thing that opens that door", () => {
  it("passes the address question's answer to every door it opens", () => {
    const mounts = [...window_.matchAll(/<Connect\b/g)].length;
    const gated = [...window_.matchAll(/fixed=\{!own\.ask\}/g)].length;
    // Two: the first run, and a server whose token has died.
    expect(mounts).toBe(2);
    expect(gated).toBe(mounts);
  });
});
