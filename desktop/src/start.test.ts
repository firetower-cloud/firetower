import { describe, expect, test } from "vitest";
import { dropSeed, seedWaiting } from "./start";
import type { Seed } from "./start";

/* `useStart` is the only way to set a seed, and it navigates on the way out.
   There is no DOM in this suite, so the two properties the hash router
   touches are stubbed — the subject here is the reading, not the routing, and
   a seed that could be set without `start()` would be a seam that exists for
   the test rather than for the app. */
const win = globalThis as unknown as { window?: unknown };
win.window ??= { location: { hash: "" }, history: { replaceState() {} } };

async function leave(seed: Seed) {
  const { useStart } = await import("./start");
  useStart()(seed);
}

describe("the seed a task's Start leaves", () => {
  test("reading it twice gives the same seed, because it happens twice", async () => {
    /* Measured, not supposed: `consumeSeed` was read once in a `useMemo` and
       cleared as it read, and driving one press counted two calls — React
       double-invokes the factory under StrictMode. It worked only because
       React keeps the first result. */
    const seed: Seed = { taskKey: "NW-4120", title: "Quota meter goes amber", taskUrl: "https://x.invalid/1" };
    await leave(seed);
    expect(seedWaiting()).toBe(seed);
    expect(seedWaiting()).toBe(seed);
  });

  test("dropping it clears it, so a later visit to the home opens empty", async () => {
    const seed: Seed = { taskKey: "NW-4120" };
    await leave(seed);
    dropSeed(seed);
    expect(seedWaiting()).toBeUndefined();
  });

  test("and dropping a seed that is no longer pending leaves the new one alone", async () => {
    /* On a route key change React renders the arriving subtree before it runs
       the leaving one's cleanups. An unconditional clear would happen to work
       and would break the day that ordering changed. */
    const old: Seed = { taskKey: "NW-4099" };
    const fresh: Seed = { taskKey: "NW-4120" };
    await leave(old);
    await leave(fresh);
    dropSeed(old);
    expect(seedWaiting()).toBe(fresh);
  });
});
