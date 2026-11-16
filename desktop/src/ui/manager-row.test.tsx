import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ManagerRow } from "./OverviewTab";
import type { Session, SessionStatus } from "~/api/generated/model";

/**
 * The mark on the manager's row in the Team panel.
 *
 * Reported as "whenever he opens a subworkspace on the team the manager has a
 * running animation (even though he is done)", with four children all at rest
 * above a manager pulsing away. The row rendered
 * `status={active ? manager.status : "Working"}` — a literal, not a reading —
 * and `active` is true only when the manager *is* the workspace you have
 * open. So from inside any child, the branch taken was the constant one, and
 * it never depended on anything that could change.
 *
 * "Done" is the mildest version of it. The same literal drew a manager that
 * had **failed**, and one **waiting on an answer**, as healthy progress —
 * which is the state somebody working in a child most needs to see.
 *
 * So what is pinned here is that every status reaches the mark, from both
 * sides of `active`. The alphabet itself is `BeatMark`'s and is not retested:
 * a tick is `lucide`'s `Check`, a failure is `TriangleAlert`, working is the
 * three pulsing dots of `.typing`, and blocked is the ember `.dot`.
 */

const manager = (status: SessionStatus): Session =>
  ({
    id: "s_lead",
    name: "lead / numen",
    status,
    agent: "ClaudeCode",
    createdAt: "2026-11-07T09:00:00Z",
  }) as Session;

/** What the row draws, as the one word for the mark in it. */
function mark(status: SessionStatus, active = false): string {
  const html = renderToStaticMarkup(<ManagerRow manager={manager(status)} active={active} />);
  if (html.includes('class="typing')) return "working";
  if (html.includes("lucide-triangle-alert")) return "failed";
  if (html.includes("lucide-check")) return "done";
  if (html.includes('class="dot"')) return "blocked";
  return `no mark: ${html.slice(0, 120)}`;
}

describe("the manager's row, read from inside a child", () => {
  test("a manager that has finished reads as finished", () => {
    // The report. Before the fix both of these were "working".
    expect(mark("HandedBack")).toBe("done");
    expect(mark("Ready")).toBe("done");
  });

  test("a manager that failed says so, rather than drawing progress", () => {
    expect(mark("Failed")).toBe("failed");
  });

  test("a manager waiting on an answer says so", () => {
    expect(mark("NeedsYou")).toBe("blocked");
  });

  test("a manager that really is working still animates", () => {
    // The case the literal got right by coincidence, and the one a fix must
    // not cost.
    expect(mark("Working")).toBe("working");
    expect(mark("Starting")).toBe("working");
  });

  test("an ended manager is a mark and not an animation", () => {
    expect(mark("Ended")).toBe("done");
  });

  test("the row is the way up to it", () => {
    expect(renderToStaticMarkup(<ManagerRow manager={manager("HandedBack")} active={false} />)).toContain("<button");
  });
});

describe("the manager's own workspace, which was always right", () => {
  test("it reads its real status there too", () => {
    for (const status of ["HandedBack", "Failed", "NeedsYou", "Working"] as SessionStatus[])
      expect(mark(status, true)).toBe(mark(status, false));
  });

  test("and it is the row you are standing on, with the badge to say so", () => {
    const html = renderToStaticMarkup(<ManagerRow manager={manager("Working")} active />);
    expect(html).toContain("here");
    expect(html).toContain('data-here="true"');
  });
});
