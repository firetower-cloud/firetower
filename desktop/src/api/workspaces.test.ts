/**
 * Finding the place an address belongs to.
 *
 * A workspace is a group of sessions, and the address can name the workspace
 * or any one agent in it. The case that broke is the third: the agent named in
 * the address having ended.
 */
import { describe, expect, it } from "vitest";
import { group, placeOf } from "./workspaces";
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
