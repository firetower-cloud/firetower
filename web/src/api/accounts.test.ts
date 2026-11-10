import { describe, expect, test } from "vitest";
import { exhausted } from "./accounts";
import type { Limit } from "./generated/model";

/* One window, with whatever this test is about put on top. `observedAt` is on
   every `Limit` and read by none of these: exhaustion is about the status and
   the reset, and the age is for whoever has to decide how much to trust the
   number beside it. */
const window = (over: Partial<Limit>): Limit => ({
  scope: "account",
  status: "allowed",
  resetsAt: null,
  usedPercent: null,
  observedAt: "2026-11-09T12:00:00Z",
  ...over,
});

describe("account exhaustion", () => {
  test("unknown statuses and temporary throttling do not exhaust an account", () => {
    for (const status of ["allowed", "allowed_warning", "unknown", "rate_limit_exceeded", "authentication_error"]) {
      expect(exhausted(window({ status }))).toBe(false);
    }
  });
  test("an elapsed reset makes a window eligible to retry", () => {
    const rejected = window({ scope: "five_hour", status: "rejected", resetsAt: 100 });
    expect(exhausted(rejected, 99)).toBe(true);
    expect(exhausted(rejected, 101)).toBe(false);
  });
  test("a blocking error without a reset remains visible", () => {
    expect(exhausted(window({ status: "blocked" }))).toBe(true);
  });
});
