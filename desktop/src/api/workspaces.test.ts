/**
 * Finding the place an address belongs to.
 *
 * A workspace is a group of sessions, and the address can name the workspace
 * or any one agent in it. The case that broke is the third: the agent named in
 * the address having ended.
 */
import { describe, expect, it } from "vitest";
import { childrenOf, childrenWorking, doing, group, isChild, placeOf } from "./workspaces";
import type { Session } from "~/api/generated/model";

const run = (id: string, workspaceId: string, status = "Ready"): Session =>
  ({
    id,
    workspaceId,
    status,
    repo: "acme/backend",
    name: "Test",
    title: id,
    createdAt: `2026-10-02T10:0${id.slice(-1)}:00Z`,
    agent: "ClaudeCode",
    owner: "u_1",
    path: "d/shared/test",
    number: 1,
    checkouts: [],
  }) as unknown as Session;

const places = (sessions: Session[]) => group(sessions).groups.flatMap(([, ps]) => ps);

describe("placeOf", () => {
  const all = [run("s_1", "s_1"), run("s_2", "s_1"), run("s_3", "s_1")];

  it("finds it by the workspace's own id", () => {
    expect(placeOf(places(all), "s_1")?.runs).toHaveLength(3);
  });

  it("finds it by any agent in it", () => {
    expect(placeOf(places(all), "s_3")?.runs).toHaveLength(3);
  });

  /**
   * The bug. Ending the agent you were reading takes it out of the running
   * list, so an address naming it matched nothing: a workspace with three
   * agents drew one dead chip, and reopening it brought them back — because
   * the address was a live id again.
   */
  it("still finds it after the agent in the address has ended", () => {
    const left = all.filter((s) => s.id !== "s_3");
    expect(
      placeOf(places(left), "s_3"),
      "nothing names s_3 any more, so the id alone cannot find it",
    ).toBeUndefined();

    const still = placeOf(places(left), "s_3", "s_1");
    expect(still?.runs).toHaveLength(2);
    expect(still?.id).toBe("s_1");
  });

  it("is undefined when the whole place is gone", () => {
    expect(placeOf(places([]), "s_3", "s_1")).toBeUndefined();
  });
});

/**
 * A lead and what it delegated read as one piece of work.
 *
 * A child in a workspace of its own sorts straight after its lead rather than
 * by its own age, a child started *in* the lead's workspace is another run of
 * that place, and a child that has handed back is its lead's business rather
 * than yours.
 */
describe("leads and children", () => {
  const child = (id: string, parentId: string, workspaceId = id, status = "Working"): Session =>
    ({ ...run(id, workspaceId, status), parentId }) as unknown as Session;

  it("puts a child straight after its lead, newest siblings first", () => {
    // Ages: s_1 oldest … s_4 newest. Without leads the order is 4, 3, 2, 1.
    const all = [run("s_1", "s_1"), child("s_2", "s_1"), run("s_3", "s_3"), child("s_4", "s_1")];
    expect(places(all).map((p) => p.id)).toEqual(["s_3", "s_1", "s_4", "s_2"]);
    expect(places(all).map((p) => isChild(p, places(all)))).toEqual([false, false, true, true]);
  });

  it("counts a child in its own workspace and one in the lead's alike", () => {
    const all = [run("s_1", "s_1"), child("s_2", "s_1"), child("s_3", "s_1", "s_1")];
    const lead = placeOf(places(all), "s_1")!;
    expect(lead.runs).toHaveLength(2);
    expect(childrenWorking(lead, places(all))).toBe(2);
  });

  it("leaves a child whose lead is gone where its age puts it", () => {
    const all = [run("s_3", "s_3"), child("s_2", "s_gone")];
    expect(places(all).map((p) => p.id)).toEqual(["s_3", "s_2"]);
    expect(isChild(places(all)[1], places(all))).toBe(false);
  });

  it("does not count a child's hand-back as waiting on you", () => {
    const all = [run("s_1", "s_1", "Working"), child("s_2", "s_1", "s_2", "HandedBack")];
    const [, kid] = places(all);
    expect(kid.id).toBe("s_2");
    expect(doing(kid)).toBe("idle");
    // The same status with nobody to hand back to is yours.
    expect(doing(places([run("s_9", "s_9", "HandedBack")])[0])).toBe("waiting");
  });
});

describe("childrenOf", () => {
  const child = (id: string, parentId: string, workspaceId = id, status = "Working"): Session =>
    ({ ...run(id, workspaceId, status), parentId }) as unknown as Session;

  it("counts what ending the place takes with it, and not what has already ended", () => {
    const all = [run("s_1", "s_1"), child("s_2", "s_1"), child("s_3", "s_1", "s_1"), child("s_4", "s_1", "s_4", "Ended")];
    // An ended session is not listed by the rail at all; here it is, and it
    // still must not count.
    const lead = placeOf(places(all), "s_1")!;
    expect(childrenOf(lead, places(all))).toBe(3);
  });
});
