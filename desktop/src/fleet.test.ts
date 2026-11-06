import { describe, expect, test } from "vitest";
import { marksOf } from "./fleet";

describe("a Firetower's monogram", () => {
  test("is the first two letters of the organisation", () => {
    expect(marksOf(["Northwind", "Ledger"])).toEqual(["No", "Le"]);
  });

  /* The bug this replaced: `org.slice(0, 1)` made both of these "A". A mark
     two servers share is not a mark. */
  test("two organisations sharing a first letter stay apart", () => {
    expect(marksOf(["Acme", "Apex"])).toEqual(["Ac", "Ap"]);
    expect(marksOf(["Northwind", "Nimbus"])).toEqual(["No", "Ni"]);
  });

  /* Sharing the *second* letter too: the loser walks its own name for the
     first letter still free, so the mark stays an abbreviation of the thing. */
  test("and so do two sharing the first two", () => {
    expect(marksOf(["Northwind", "Nova"])).toEqual(["No", "Nv"]);
    expect(marksOf(["Ledger", "Lever", "Levity"])).toEqual(["Le", "Lv", "Li"]);
  });

  /* Only a shared first letter is a collision; everything else is already
     distinct and should keep its own natural second letter. */
  test("a different first letter is never a collision", () => {
    expect(marksOf(["Acme", "Nova", "Apex"])).toEqual(["Ac", "No", "Ap"]);
  });

  test("punctuation and spacing are not half the monogram", () => {
    expect(marksOf(["@westlabs"])).toEqual(["We"]);
    expect(marksOf(["N W Partners"])).toEqual(["Nw"]);
  });

  /* Two Firetowers for one organisation — staging and production — still come
     out apart, from the same name's own letters. `org / user` in the title bar
     says which is which; the mark only has to not lie about them being two. */
  test("the same name twice still makes two marks", () => {
    expect(marksOf(["Ledger", "Ledger"])).toEqual(["Le", "Ld"]);
  });

  /* The one genuine collision: two names with no letters left to tell apart.
     It takes two organisations called the same two characters, and the mark
     repeating is the honest answer. */
  test("and only an exhausted name repeats", () => {
    expect(marksOf(["Lo", "Lo"])).toEqual(["Lo", "Lo"]);
  });

  test("a one-letter name keeps its one letter", () => {
    expect(marksOf(["X"])).toEqual(["X"]);
  });
});
