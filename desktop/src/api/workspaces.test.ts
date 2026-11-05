/**
 * Finding the place an address belongs to.
 *
 * A workspace is a group of sessions, and the address can name the workspace
 * or any one agent in it. The case that broke is the third: the agent named in
 * the address having ended.
 */
import { describe, expect, it } from "vitest";
import { childrenElsewhere, childrenWorking, doing, group, isChild, placeBeat, placeOf, rowLabel, speaksFor } from "./workspaces";
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

describe("childrenElsewhere", () => {
  const child = (id: string, parentId: string, workspaceId = id, status = "Working"): Session =>
    ({ ...run(id, workspaceId, status), parentId }) as unknown as Session;

  it("counts what ending the place takes with it beyond the agents in it", () => {
    const all = [run("s_1", "s_1"), child("s_2", "s_1"), child("s_3", "s_1", "s_1"), child("s_4", "s_4", "s_4", "Ended")];
    const lead = placeOf(places(all), "s_1")!;
    // s_3 is a child *in* this workspace: it is already one of the agents the
    // question counts, and adding it here announced it twice, the second time
    // as being somewhere it is not. s_4 has ended and goes with nobody.
    expect(lead.runs.map((r) => r.id).sort()).toEqual(["s_1", "s_3"]);
    expect(childrenElsewhere(lead, places(all))).toBe(1);
  });

  it("counts nothing for a place that delegated nothing", () => {
    const all = [run("s_1", "s_1"), run("s_9", "s_9")];
    expect(childrenElsewhere(placeOf(places(all), "s_1")!, places(all))).toBe(0);
  });
});

describe("rowLabel", () => {
  const child = (id: string, parentId: string, name: string, workspaceId = id): Session =>
    ({ ...run(id, workspaceId), parentId, name }) as unknown as Session;

  it("drops the lead prefix when the lead is shown above it", () => {
    const lead = { ...run("s_1", "s_1"), name: "Main session" } as unknown as Session;
    const kid = child("s_2", "s_1", "Main session / hello-fr");
    const ps = places([lead, kid]);
    const row = ps.find((p) => p.id === "s_2")!;
    expect(rowLabel(row, ps)).toBe("hello-fr");
    // The lead keeps its own name.
    expect(rowLabel(ps.find((p) => p.id === "s_1")!, ps)).toBe("Main session");
  });

  it("keeps the full name where the lead is not on the list", () => {
    const kid = child("s_2", "s_gone", "Main session / hello-fr");
    const ps = places([run("s_9", "s_9"), kid]);
    const row = ps.find((p) => p.id === "s_2")!;
    expect(rowLabel(row, ps)).toBe("Main session / hello-fr");
  });
});

/**
 * One workspace, one answer.
 *
 * The rail's mark used to be `beatOf(place.runs[0])`, and `group()` sorts
 * whichever run wants you to the front — so a manager that had handed back
 * painted its row sage while an agent it had delegated to was still typing.
 * The Overview panel, reading the same workspace, said "1 working". These are
 * the cases where one run cannot speak for the place.
 */
describe("placeBeat", () => {
  const child = (id: string, parentId: string, workspaceId = id, status = "Working"): Session =>
    ({ ...run(id, workspaceId, status), parentId }) as unknown as Session;

  /** The bug, exactly as it was reported: a lead done, a child not. */
  it("is working while an agent in the place still is, whatever the lead says", () => {
    const all = [run("s_1", "s_1", "HandedBack"), child("s_2", "s_1", "s_1")];
    const lead = placeOf(places(all), "s_1")!;
    // The run the old mark read, to show it is the one that was lying.
    expect(lead.runs[0].status).toBe("HandedBack");
    expect(placeBeat(lead, places(all))).toBe("working");
  });

  /** The same thing with the child off in a workspace of its own — which the
   *  rail filters out, so only the full list can answer. */
  it("is working while a delegated child elsewhere still is", () => {
    const all = [run("s_1", "s_1", "HandedBack"), child("s_2", "s_1")];
    const every = places(all);
    const lead = every.find((p) => p.id === "s_1")!;
    expect(placeBeat(lead, every)).toBe("working");
    // Handed the list the rail draws — the one its own child was cut from —
    // there is nothing left to find, which is how it went wrong.
    expect(placeBeat(lead, [lead])).toBe("done");
  });

  it("spends ember even when something beside it is working", () => {
    const all = [run("s_1", "s_1", "NeedsYou"), child("s_2", "s_1", "s_1")];
    const lead = placeOf(places(all), "s_1")!;
    expect(placeBeat(lead, places(all))).toBe("blocked");
  });

  it("says broken over done: a failure does not finish on its own", () => {
    const all = [run("s_1", "s_1", "HandedBack"), child("s_2", "s_1", "s_2", "Failed")];
    const every = places(all);
    expect(placeBeat(every.find((p) => p.id === "s_1")!, every)).toBe("broken");
  });

  it("is done only when the whole family is at rest", () => {
    const all = [run("s_1", "s_1", "HandedBack"), child("s_2", "s_1", "s_2", "HandedBack")];
    const every = places(all);
    expect(placeBeat(every.find((p) => p.id === "s_1")!, every)).toBe("done");
  });

  it("is over when every one of them has ended", () => {
    const all = [run("s_1", "s_1", "Ended"), child("s_2", "s_1", "s_1", "Ended")];
    expect(placeBeat(placeOf(places(all), "s_1")!, places(all))).toBe("over");
  });

  /**
   * The mark and the `\u21B3n` beside it are one statement: "its breathing dot
   * is honest about the tree, and this is the number behind it". A row that
   * counts delegated work still going may not also say it is at rest.
   */
  it("never reads at rest on a row that counts work still going", () => {
    for (const where of ["s_1", "s_2"]) {
      const all = [run("s_1", "s_1", "HandedBack"), child("s_2", "s_1", where)];
      const every = places(all);
      const lead = every.find((p) => p.id === "s_1")!;
      expect(childrenWorking(lead, every)).toBe(1);
      expect(["working", "blocked"]).toContain(placeBeat(lead, every));
    }
  });
});

/**
 * Who speaks for a row that has room for one mark and one age.
 *
 * `group()` sorts whichever run wants you to the front, so `place.runs[0]` is
 * a run, not the place: on the dashboard it drew a hand-back's green tick
 * beside this row's own "working" chip, and it aged an hour-old workspace by
 * the child started in it a minute ago.
 */
describe("what a row says about a place", () => {
  const child = (id: string, parentId: string, workspaceId = id, status = "Working"): Session =>
    ({ ...run(id, workspaceId, status), parentId }) as unknown as Session;

  it("does not let a lead's hand-back speak over an agent still working", () => {
    const all = [run("s_1", "s_1", "HandedBack"), child("s_2", "s_1", "s_1")];
    const place = placeOf(places(all), "s_1")!;
    expect(place.runs[0].status).toBe("HandedBack");
    expect(speaksFor(place).status).toBe("Working");
    // And it agrees with the word printed beside it on the same row.
    expect(doing(place)).toBe("working");
  });

  it("keeps a question in front of work going on beside it", () => {
    const all = [run("s_1", "s_1", "NeedsYou"), child("s_2", "s_1", "s_1")];
    expect(speaksFor(placeOf(places(all), "s_1")!).status).toBe("NeedsYou");
  });

  /** The dashboard lists the child's workspace in its own right, so a lead
   *  that spoke for it as well would say the same thing twice. */
  it("speaks only for the agents in this place", () => {
    const all = [run("s_1", "s_1", "HandedBack"), child("s_2", "s_1")];
    const every = places(all);
    const lead = every.find((p) => p.id === "s_1")!;
    expect(speaksFor(lead).status).toBe("HandedBack");
    // The rail, which hides that child, asks the other question.
    expect(placeBeat(lead, every)).toBe("working");
  });

  it("is as old as the place, not as the newest thing in it", () => {
    // s_1 cut the workspace; s_5 is a child started in it long after.
    const all = [run("s_1", "s_1", "Working"), child("s_5", "s_1", "s_1", "NeedsYou")];
    const place = placeOf(places(all), "s_1")!;
    expect(place.runs[0].id, "the needs-you child sorts to the front").toBe("s_5");
    expect(place.startedAt).toBe(run("s_1", "s_1").createdAt);
  });

  it("falls back to the oldest run still here when the founder has gone", () => {
    const all = [child("s_5", "s_1", "s_1"), child("s_3", "s_1", "s_1")];
    const place = placeOf(places(all), "s_1")!;
    expect(place.startedAt).toBe(run("s_3", "s_1").createdAt);
  });
});
