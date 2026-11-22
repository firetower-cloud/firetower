/**
 * The team panel's tree, as numbers.
 *
 * The defect this exists for is one filter stopping at the first generation,
 * so the test that matters most is the shape of a three-deep team — the one
 * from the run that reported it.
 */
import { describe, expect, it } from "vitest";
import type { Session } from "~/api/generated/model";
import { CAP, teamUnder, working } from "./team-tree";

const at = (over: Partial<Session> & { id: string; name: string }): Session =>
  ({
    parentId: null,
    status: "Ended",
    agent: "ClaudeCode",
    createdAt: "2026-11-22T10:00:00Z",
    ...over,
  }) as Session;

/** Lead → Designer, QA, Engineer → two advisors → one reviewer. */
const run = (): Session[] => [
  at({ id: "lead", name: "Run!" }),
  at({ id: "designer", name: "Designer", parentId: "lead" }),
  at({ id: "qa", name: "QA", parentId: "lead" }),
  at({ id: "eng", name: "Engineer", parentId: "lead" }),
  at({ id: "ios", name: "iOS Advisor", parentId: "eng" }),
  at({ id: "sec", name: "Security Advisor", parentId: "eng" }),
  at({ id: "rev", name: "Reviewer", parentId: "sec" }),
  at({ id: "deeper", name: "Deeper", parentId: "rev" }),
];

describe("the team under a manager", () => {
  it("reaches every generation, not just the first", () => {
    // The whole point: four of six were on screen before this.
    const team = teamUnder(run(), "lead");
    expect(team.map((m) => m.session.id)).toEqual([
      "designer",
      "eng",
      "ios",
      "sec",
      "rev",
      "deeper",
      "qa",
    ]);
  });

  it("carries how deep each one sits", () => {
    const team = teamUnder(run(), "lead");
    const depth = (id: string) => team.find((m) => m.session.id === id)!.depth;
    expect(depth("designer")).toBe(1);
    expect(depth("ios")).toBe(2);
    expect(depth("rev")).toBe(3);
    expect(depth("deeper")).toBe(4);
  });

  it("names the parent only past the cap, where the rail stops indenting", () => {
    const team = teamUnder(run(), "lead");
    const under = (id: string) => team.find((m) => m.session.id === id)!.under;
    expect(under("ios")).toBe(null);
    expect(under("rev")).toBe(null);
    // Depth 4 is the first that is no longer indented, so it says whose it is.
    expect(under("deeper")).toBe("Reviewer");
    expect(CAP).toBe(3);
  });

  it("sorts within a sibling group, never across generations", () => {
    /* A flat sort by status would put a working grandchild above the parent
       that started it, and the rail would draw a child above its manager. */
    const sessions = [
      at({ id: "lead", name: "Lead" }),
      at({ id: "a", name: "Aaa", parentId: "lead", status: "Ended" }),
      at({ id: "b", name: "Bbb", parentId: "lead", status: "Working" }),
      at({ id: "a1", name: "Child of Aaa", parentId: "a", status: "Working" }),
    ];
    const team = teamUnder(sessions, "lead");
    // Bbb is working so it leads its own group; Aaa's child stays under Aaa.
    expect(team.map((m) => m.session.id)).toEqual(["b", "a", "a1"]);
  });

  it("reads the team from any member, not only the lead", () => {
    // The panel shows the team around the manager, so a middle agent asked
    // about its own id sees what it leads.
    const team = teamUnder(run(), "eng");
    expect(team.map((m) => m.session.id)).toEqual(["ios", "sec", "rev", "deeper"]);
    expect(team[0]!.depth).toBe(1);
  });

  it("answers for a manager with nobody under it", () => {
    expect(teamUnder(run(), "designer")).toEqual([]);
  });

  it("counts what is running across the whole tree", () => {
    const sessions: Session[] = run().map((s) =>
      s.id === "deeper" || s.id === "qa" ? { ...s, status: "Working" as const } : s,
    );
    expect(working(teamUnder(sessions, "lead"))).toBe(2);
  });

  it("cannot loop on a parent that points back into the tree", () => {
    // Not reachable — a parent is set once, at spawn, to something that
    // already exists — but a render loop is a frozen window.
    const sessions = [
      at({ id: "lead", name: "Lead" }),
      at({ id: "a", name: "A", parentId: "lead" }),
      at({ id: "b", name: "B", parentId: "a" }),
    ];
    (sessions[1] as { parentId: string }).parentId = "b";
    expect(() => teamUnder(sessions, "lead")).not.toThrow();
  });
});
