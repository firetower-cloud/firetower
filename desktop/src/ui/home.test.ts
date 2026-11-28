import { describe, expect, test } from "vitest";
import { OPENERS, opener, ROWS, severityFirst } from "./Home";
import type { Workspace } from "~/api/workspaces";
import type { Session, SessionStatus } from "~/api/generated/model";

/**
 * The order of *Recent agents*, which is the one rule on this screen that an
 * eye cannot check and a list can.
 *
 * It replaced three headings — *Waiting for you*, *Handed back*, *Working* —
 * and the ember rule they carried with them (`DOTTED`, two dots then a count).
 * **That rule is a measurement now, not an arithmetic one:** the chips are
 * clipped to `ROWS` rows read off the layout, and what is clipped away is not
 * on screen to count. It is asserted by `design-rules.mjs` against a rendered
 * page, where it belongs, and there is nothing left here to slice.
 */
const place = (id: string, status: SessionStatus, over: Partial<Workspace> = {}): Workspace => ({
  id,
  name: id,
  startedAt: "2026-11-07T09:00:00Z",
  runs: [{ id: `s-${id}`, status, createdAt: "2026-11-07T09:00:00Z" } as Session],
  ...over,
});

describe("the order of Recent agents", () => {
  test("severity first, then what finished, then what is still going", () => {
    const every = [
      place("working", "Working"),
      place("done", "HandedBack"),
      place("broken", "Failed"),
      place("blocked", "NeedsYou"),
    ];
    expect([...every].sort(severityFirst(every)).map((p) => p.id)).toEqual([
      "broken",
      "blocked",
      "done",
      "working",
    ]);
  });

  test("broken leads, which is the one difference from the rail's precedence", () => {
    /* `placeBeat` puts `blocked` first — ember is spent on being stuck and on
       nothing else, which is right for choosing one mark for one row. Reading
       a row left to right, a failed run leads: it is the one thing here you
       cannot act on by waiting. */
    const every = [place("blocked", "NeedsYou"), place("broken", "Failed")];
    expect([...every].sort(severityFirst(every))[0].id).toBe("broken");
  });

  test("the order is stable, so what group() put first stays first inside a beat", () => {
    const every = [
      place("a", "Working"),
      place("b", "NeedsYou"),
      place("c", "Working"),
      place("d", "NeedsYou"),
      place("e", "Working"),
    ];
    expect([...every].sort(severityFirst(every)).map((p) => p.id)).toEqual(["b", "d", "a", "c", "e"]);
  });

  test("a child's beat counts for its lead, because the child has no chip", () => {
    /* A delegated child in a workspace of its own is filtered out of the home
       and drawn under its lead in the Overview tab. Its lead has to wear what
       it is doing, or a workspace with a stuck child reads as working. */
    const lead = place("lead", "Working");
    const kid = place("kid", "NeedsYou", { leadOf: "s-lead" });
    const other = place("other", "Working");
    /* `other` is listed first, so a stable sort would leave it first if the
       lead's own run were all that was read. */
    const drawn = [other, lead];
    expect(drawn.sort(severityFirst([...drawn, kid])).map((p) => p.id)).toEqual(["lead", "other"]);
  });

  test("two rows, and one is a parameter rather than a rewrite", () => {
    expect(ROWS).toBe(2);
  });
});

/**
 * The headline is not the same sentence every morning.
 *
 * `opener` takes its randomness as an argument, so these are facts rather
 * than five hundred rolls and a hope.
 */
describe("the opening line", () => {
  test("offers five, so the home does not wear one sentence out", () => {
    expect(new Set(OPENERS).size).toBe(5);
  });

  /* Each stands alone now — there is no greeting in front of it — so each
     opens with a capital and closes its own sentence. */
  test("is a whole sentence on its own", () => {
    for (const line of OPENERS) {
      expect(line[0]).toBe(line[0]?.toUpperCase());
      expect(line).toMatch(/[.?]$/);
    }
  });

  test("can reach every one of them", () => {
    const seen = OPENERS.map((_, i) => opener(() => i / OPENERS.length));
    expect(new Set(seen).size).toBe(OPENERS.length);
  });

  /** The ends of the range, where a rounding slip would read past the array
      and render the word `undefined` across the top of the home. */
  test("never falls off either end", () => {
    expect(opener(() => 0)).toBe(OPENERS[0]);
    expect(opener(() => 0.999999)).toBe(OPENERS[OPENERS.length - 1]);
    expect(opener(() => 1)).toBe(OPENERS[OPENERS.length - 1]);
  });
});
