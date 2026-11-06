import { describe, expect, test } from "vitest";
import { DESTINATIONS, DOORS, destinationAt } from "./destinations";

describe("the rail's own shape", () => {
  /* Six and two, and the two are below a rule because they are doors rather
     than destinations — which is also why they have no number key. */
  test("six destinations, each on its own number", () => {
    expect(DESTINATIONS).toHaveLength(6);
    expect(DESTINATIONS.map((d) => d.key)).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  test("two doors, and neither takes a number", () => {
    expect(DOORS.map((d) => d.id)).toEqual(["settings", "updates"]);
    expect(DOORS.every((d) => !d.key)).toBe(true);
  });
});

describe("which destination a path is in", () => {
  test("the six, from their own addresses", () => {
    expect(destinationAt("/")).toBe("home");
    expect(destinationAt("/tasks")).toBe("tasks");
    expect(destinationAt("/artifacts")).toBe("artifacts");
  });

  /* A detail screen keeps its destination's rail mark: you are still in
     Dashboard when you are reading one workspace, and still in Customize when
     you are reading one skill. */
  test("a workspace is still the Dashboard", () => {
    expect(destinationAt("/sessions/w_1")).toBe("home");
    expect(destinationAt("/new")).toBe("home");
  });

  /* The twelve configuration panes used to be one screen behind one rail
     entry. Each now belongs to the destination it is about. */
  test("every configuration pane belongs to somebody", () => {
    expect(destinationAt("/configuration/skills")).toBe("customize");
    expect(destinationAt("/configuration/roles")).toBe("customize");
    expect(destinationAt("/configuration/agents")).toBe("customize");
    expect(destinationAt("/configuration/repositories")).toBe("repos");
    expect(destinationAt("/configuration/git-hosts")).toBe("repos");
    expect(destinationAt("/configuration/machines")).toBe("machines");
    expect(destinationAt("/configuration/trackers")).toBe("tasks");
    expect(destinationAt("/configuration/people")).toBe("settings");
    expect(destinationAt("/configuration/teams")).toBe("settings");
    expect(destinationAt("/configuration/directories")).toBe("settings");
    expect(destinationAt("/configuration/vault")).toBe("settings");
    expect(destinationAt("/configuration/server")).toBe("settings");
  });

  /* An address from an older build, or one somebody typed. It lands in
     Settings rather than lighting nothing, because `Configuration.tsx` falls
     back to a real pane rather than drawing an empty screen. */
  test("a pane nobody recognises still lights a destination", () => {
    expect(destinationAt("/configuration/nonsense")).toBe("settings");
    expect(destinationAt("/configuration")).toBe("settings");
  });

  /* The screens that are nobody's. Lighting the Dashboard for the account
     screen would say you are somewhere you are not. */
  test("and the screens that belong to no destination say so", () => {
    expect(destinationAt("/account")).toBeNull();
    expect(destinationAt("/connect")).toBeNull();
    expect(destinationAt("/setup")).toBeNull();
    expect(destinationAt("/style")).toBeNull();
  });
});
