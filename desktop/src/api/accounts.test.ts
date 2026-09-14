import { describe, expect, test } from "vitest";
import { exhausted } from "./accounts";

describe("account exhaustion", () => {
  test("unknown statuses and temporary throttling do not exhaust an account", () => {
    for (const status of ["allowed", "allowed_warning", "unknown", "rate_limit_exceeded", "authentication_error"]) {
      expect(exhausted({ scope: "account", status, resetsAt: null, usedPercent: null })).toBe(false);
    }
  });
  test("an elapsed reset makes a window eligible to retry", () => {
    expect(exhausted({ scope: "five_hour", status: "rejected", resetsAt: 100, usedPercent: null }, 99)).toBe(true);
    expect(exhausted({ scope: "five_hour", status: "rejected", resetsAt: 100, usedPercent: null }, 101)).toBe(false);
  });
  test("a blocking error without a reset remains visible", () => {
    expect(exhausted({ scope: "account", status: "blocked", resetsAt: null, usedPercent: null })).toBe(true);
  });
});
