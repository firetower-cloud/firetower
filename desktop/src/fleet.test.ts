import { describe, expect, test } from "vitest";
import { markOf, marksOf } from "./fleet";

describe("a Firetower's monogram", () => {
  test("is the first two letters of the organisation", () => {
    expect(markOf("Northwind")).toBe("No");
    expect(markOf("Ledger")).toBe("Le");
  });

  /* The bug this replaced: `org.slice(0, 1)` made both of these "A". A mark
     two servers share is not a mark. */
  test("two organisations sharing a first letter stay apart", () => {
    expect(marksOf(["Acme", "Apex"])).toEqual(["Ac", "Ap"]);
    expect(marksOf(["Northwind", "Nimbus"])).toEqual(["No", "Ni"]);
  });

  /* Two words give their two initials, which reads better than the first two
     letters of the first one and separates more names. */
  test("a name with two words gives its two initials", () => {
    expect(markOf("Ledger Ops")).toBe("Lo");
    expect(markOf("N W Partners")).toBe("Nw");
  });

  test("punctuation and spacing are not half the monogram", () => {
    expect(markOf("@westlabs")).toBe("We");
    expect(markOf("acme-corp")).toBe("Ac");
  });

  test("a one-letter name keeps its one letter", () => {
    expect(markOf("X")).toBe("X");
    expect(markOf("")).toBe("?");
  });

  /* Honest rather than clever. Two names that land on the same two letters
     keep the same mark — a staging and a production Firetower for one
     organisation genuinely *have* the same name — and the `org / user` beside
     every mark is what tells them apart. Re-lettering one of them would cost
     the property below, which is worth more. */
  test("two names that collide keep the same mark", () => {
    expect(marksOf(["Northwind", "Nova"])).toEqual(["No", "No"]);
    expect(marksOf(["Ledger", "Ledger"])).toEqual(["Le", "Le"]);
  });
});

/**
 * The property the whole thing exists for.
 *
 * A mark is an identity, and an identity that changes when something unrelated
 * happens is not one. The first derivation walked the fleet to de-duplicate,
 * which meant connecting a *Nova* silently re-lettered *Northwind* — so
 * somebody who had learned "No is production" would have been wrong about it
 * one day.
 */
describe("and it never moves", () => {
  const FLEETS = [
    [],
    ["Northwind"],
    ["Northwind", "Nova"],
    ["Nova", "Northwind"],
    ["Acme", "Northwind", "Apex", "Nova", "Ledger"],
    ["Ledger", "Acme"],
  ];

  test("whoever else is connected, and in whatever order", () => {
    for (const name of ["Northwind", "Nova", "Acme", "Apex", "Ledger"]) {
      const seen = new Set<string>();
      for (const fleet of FLEETS) {
        const marks = marksOf([...fleet, name]);
        seen.add(marks[marks.length - 1]);
        /* And when it is already in the fleet, at every position it can be in. */
        const at = fleet.indexOf(name);
        if (at >= 0) seen.add(marksOf(fleet)[at]);
      }
      expect([...seen]).toEqual([markOf(name)]);
    }
  });

  /* The two gestures that used to move it. */
  test("connecting another Firetower does not re-letter one you had", () => {
    expect(marksOf(["Northwind"])[0]).toBe(marksOf(["Northwind", "Nova"])[0]);
  });

  test("and disconnecting one does not re-letter what is left", () => {
    expect(marksOf(["Northwind", "Nova"])[1]).toBe(marksOf(["Nova"])[0]);
  });
});
