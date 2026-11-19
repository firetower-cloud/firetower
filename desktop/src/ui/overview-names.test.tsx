import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ManagerRow } from "./OverviewTab";
import type { Session } from "~/api/generated/model";

/**
 * The name on a Team row, and the guard in front of it.
 *
 * `agentName` carries a comment saying it is guarded "because an answer that
 * is not this shape should not take the panel down" — written after the third
 * crash from exactly that. It was not: `!name` catches `undefined`, `null`
 * and `""` and lets everything else through to `lastIndexOf`, so the one
 * shape the comment names — something that is not a string at all — reached
 * the call it was supposed to be held back from and the whole Overview became
 * the error boundary again.
 *
 * Driven through the real row rather than the function alone, because the
 * promise is about the panel staying up and not about a return value.
 */
const row = (name: unknown): Session =>
  ({
    id: "s_lead",
    name,
    status: "Working",
    agent: "ClaudeCode",
    createdAt: "2026-11-07T09:00:00Z",
  }) as Session;

const draw = (name: unknown) => renderToStaticMarkup(<ManagerRow manager={row(name)} active={false} />);

describe("a name that is not the shape the wire promised", () => {
  test("a number does not take the panel down", () => {
    // The report. Before the fix: "name.lastIndexOf is not a function".
    expect(() => draw(42)).not.toThrow();
    expect(draw(42)).toContain("Untitled");
  });

  test("an object does not either", () => {
    expect(() => draw({})).not.toThrow();
    expect(draw({})).toContain("Untitled");
  });

  test("nor an array, which has a lastIndexOf and so got further", () => {
    // This one never threw — `[].lastIndexOf(" / ")` is -1, so the array fell
    // through as the name and React was handed it to render. Still not a name.
    expect(() => draw(["lead / numen"])).not.toThrow();
    expect(draw(["lead / numen"])).toContain("Untitled");
  });

  test("the empty and absent cases the old guard did catch, still caught", () => {
    expect(draw(undefined)).toContain("Untitled");
    expect(draw(null)).toContain("Untitled");
    expect(draw("")).toContain("Untitled");
  });
});

describe("a name that is the shape the wire promised", () => {
  test("a delegated child drops the lead's prefix", () => {
    expect(draw("lead / numen")).toContain("numen");
    expect(draw("lead / numen")).not.toContain("lead / numen");
  });

  test("a name with no prefix is left alone", () => {
    expect(draw("numen")).toContain("numen");
    expect(draw("numen")).not.toContain("Untitled");
  });

  test("the last separator wins, so a lead of a lead reads as the agent", () => {
    expect(draw("lead / middle / numen")).toContain("numen");
    expect(draw("lead / middle / numen")).not.toContain("middle");
  });
});
