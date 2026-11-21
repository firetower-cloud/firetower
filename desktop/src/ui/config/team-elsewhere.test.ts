/**
 * The readers for fields another branch owns.
 *
 * What is worth pinning is that each answers a **sensible** number while the
 * field is absent, rather than throwing or drawing a warning about nothing —
 * this branch stacks on one where none of them exists yet — and that it
 * actually reads the field once it does. A reader that quietly answered zero
 * forever would make a seam look wired when it is not.
 */
import { describe, expect, test } from "vitest";
import { arrivedOnItsOwn, autoAddedCount, schedulesPinning } from "./team-elsewhere";

describe("schedules a save would pause", () => {
  test("none, while the field is not there", () => {
    expect(schedulesPinning({ id: "t_1", name: "Platform" })).toBe(0);
    expect(schedulesPinning(undefined)).toBe(0);
    expect(schedulesPinning(null)).toBe(0);
  });

  test("the number, once it is", () => {
    expect(schedulesPinning({ id: "t_1", schedules: 4 })).toBe(4);
    expect(schedulesPinning({ id: "t_1", schedules: 0 })).toBe(0);
  });

  test("never below zero, whatever arrives", () => {
    expect(schedulesPinning({ schedules: -3 })).toBe(0);
    expect(schedulesPinning({ schedules: null })).toBe(0);
  });
});

describe("seats nobody placed", () => {
  test("a seat with no timestamp was placed by somebody", () => {
    expect(arrivedOnItsOwn({ id: "p_1", profile: "r_1" })).toBe(false);
    expect(arrivedOnItsOwn({ id: "p_1", autoAddedAt: null })).toBe(false);
    expect(arrivedOnItsOwn(undefined)).toBe(false);
  });

  test("a seat with one did not", () => {
    expect(arrivedOnItsOwn({ autoAddedAt: "2026-11-02T09:00:00Z" })).toBe(true);
  });

  /* Exact where the tree is in hand, which is the map; off the team where it
     is not, which is one row of a list. */
  test("counted off the seats when there are seats, and off the team otherwise", () => {
    const seats = [{}, { autoAddedAt: "2026-11-02T09:00:00Z" }, { autoAddedAt: "x" }];
    expect(autoAddedCount({ autoAdded: 99 }, seats)).toBe(2);
    expect(autoAddedCount({ autoAdded: 3 })).toBe(3);
    expect(autoAddedCount({ id: "t_1" })).toBe(0);
    expect(autoAddedCount({ id: "t_1" }, [])).toBe(0);
  });
});
