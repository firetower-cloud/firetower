/**
 * A workspace's id is not a session's, and three screens got that wrong.
 *
 * `group()` files a workspace under `session.workspaceId ?? session.id`, so
 * for anything that belongs to a workspace, `Workspace.id` is the
 * **workspace's** id. Several things want a **session's** instead:
 * `getConversation`, `answerRequest`, and `workspace/repo.tsx`, which reads
 * its route param straight into `useSession`.
 *
 * That cost the peek its whole purpose. It passed `place.id` to
 * `getConversation`, which asked for a conversation that does not exist — so
 * the pending request never resolved and the Allow/No buttons never rendered,
 * while the ember dot showed correctly because `blocked` is read off the runs.
 * The symptom pointed at the fold; the fold was fine.
 *
 * Both ids are opaque strings, so no type can tell them apart. This is what
 * there is instead: the distinction stated once, where it is cheap to check.
 */
import { describe, expect, it } from "vitest";
import type { Session } from "~/api/generated/model";
import { group, isChild, lead, leadPlace, placeOf } from "~/api/workspaces";

/** Enough of a session for `group` and `lead`. */
const run = (over: Partial<Session> & { id: string }): Session =>
  ({
    name: "Quota meter rounding",
    status: "Working",
    agent: "ClaudeCode",
    repo: "acme/web",
    createdAt: "2026-11-08T10:00:00Z",
    updatedAt: "2026-11-08T10:00:00Z",
    ...over,
  }) as Session;

describe("a workspace's id", () => {
  it("is the workspace's, not the lead run's, when the two differ", () => {
    const { groups } = group([
      run({ id: "s_lead", workspaceId: "w_1", status: "NeedsYou" }),
      run({ id: "s_other", workspaceId: "w_1" }),
    ]);
    const place = groups[0][1][0];

    expect(place.id).toBe("w_1");
    // The peek asked `getConversation` for this and got nothing back.
    expect(place.id).not.toBe(lead(place).id);
  });

  it("falls back to the session's own id when there is no workspace", () => {
    const { groups } = group([run({ id: "s_alone" })]);
    const place = groups[0][1][0];

    // Which is why the bug hid: with no `workspaceId` the two coincide, and
    // everything works until a session belongs to a workspace.
    expect(place.id).toBe("s_alone");
    expect(place.id).toBe(lead(place).id);
  });

  /**
   * **`lead()` is not the run to answer, and this is the trap under the trap.**
   *
   * `doing()` reports `working` if *any* run is in flight, so a workspace with
   * one busy agent and one blocked one leads with the busy one — correct for
   * "whose transcript do I open", wrong for "which request am I answering".
   *
   * The peek's first fix swapped a workspace id for `lead().id` and would
   * still have fetched the wrong session here: the busy run has no pending
   * request, so the buttons would stay hidden on exactly the workspace that
   * most needs them — one where something is blocked *and* something else is
   * still running.
   */
  it("leads with the busy run even when another is blocked", () => {
    const { groups } = group([
      run({ id: "s_busy", workspaceId: "w_2" }),
      run({ id: "s_asking", workspaceId: "w_2", status: "NeedsYou" }),
    ]);
    const place = groups[0][1][0];

    expect(lead(place).id).toBe("s_busy");
    // So the peek targets the blocked run directly, not the lead.
    expect(place.runs.find((r) => r.status === "NeedsYou")?.id).toBe("s_asking");
  });

  it("gathers every run of one workspace under a single row", () => {
    const { groups } = group([
      run({ id: "s_a", workspaceId: "w_3" }),
      run({ id: "s_b", workspaceId: "w_3" }),
      run({ id: "s_c", workspaceId: "w_4" }),
    ]);
    const places = groups[0][1];
    expect(places).toHaveLength(2);
    expect(places.find((p) => p.id === "w_3")?.runs).toHaveLength(2);
  });
});

/** The places, out of their repository groups, the way every screen reads them. */
const places = (sessions: Session[]) => group(sessions).groups.flatMap(([, ps]) => ps);

/**
 * A lead and what it delegated, which the phone had no way to ask about.
 *
 * `leadOf` and the founder pass are the desk's, ported rather than reinvented:
 * the Team panel indents a roster under its manager and a member row opens the
 * workspace that member works in, and both of those are the same question —
 * *which place is this, and whose?* Three clients answering it separately is
 * how two screens come to disagree about one workspace.
 */
describe("leads and children", () => {
  it("puts a child straight after its lead, newest siblings first", () => {
    // Ages: s_1 oldest … s_4 newest. Without leads the order is 4, 3, 2, 1.
    const all = [
      run({ id: "s_1", workspaceId: "s_1", createdAt: "2026-11-08T10:01:00Z" }),
      run({ id: "s_2", workspaceId: "s_2", parentId: "s_1", createdAt: "2026-11-08T10:02:00Z" }),
      run({ id: "s_3", workspaceId: "s_3", createdAt: "2026-11-08T10:03:00Z" }),
      run({ id: "s_4", workspaceId: "s_4", parentId: "s_1", createdAt: "2026-11-08T10:04:00Z" }),
    ];
    const ps = places(all);
    expect(ps.map((p) => p.id)).toEqual(["s_3", "s_1", "s_4", "s_2"]);
    expect(ps.map((p) => isChild(p, ps))).toEqual([false, false, true, true]);
    expect(leadPlace(ps[2], ps)?.id).toBe("s_1");
  });

  /** `placement: "here"` — another agent in the lead's own checkout. It is a
   *  run of that place, not a place under it, and a place is never its own
   *  child. */
  it("counts a child started in the lead's workspace as a run of it", () => {
    const all = [
      run({ id: "s_1", workspaceId: "s_1" }),
      run({ id: "s_2", workspaceId: "s_1", parentId: "s_1" }),
    ];
    const ps = places(all);
    expect(ps).toHaveLength(1);
    expect(ps[0].runs).toHaveLength(2);
    expect(ps[0].leadOf).toBeUndefined();
    expect(isChild(ps[0], ps)).toBe(false);
  });

  it("leaves a child whose lead is gone where its own age put it", () => {
    const all = [
      run({ id: "s_2", workspaceId: "s_2", parentId: "s_gone", createdAt: "2026-11-08T10:02:00Z" }),
      run({ id: "s_3", workspaceId: "s_3", createdAt: "2026-11-08T10:03:00Z" }),
    ];
    const ps = places(all);
    expect(ps.map((p) => p.id)).toEqual(["s_3", "s_2"]);
    expect(isChild(ps[1], ps)).toBe(false);
  });

  /**
   * The founder names the place, not whichever run sorted to the front.
   *
   * `group()` puts what needs you first, so a same-workspace child that is
   * asking something takes `runs[0]` — and the workspace was then drawn under
   * the child's name rather than its own.
   */
  it("keeps the founding run's name when a child in it sorted to the front", () => {
    const all = [
      run({ id: "s_1", workspaceId: "s_1", name: "Quota meter rounding" }),
      run({
        id: "s_2",
        workspaceId: "s_1",
        parentId: "s_1",
        status: "NeedsYou",
        name: "Quota meter rounding / reviewer",
        createdAt: "2026-11-08T10:30:00Z",
      }),
    ];
    const place = places(all)[0];
    expect(place.runs[0].id, "the needs-you child sorts to the front").toBe("s_2");
    expect(place.name).toBe("Quota meter rounding");
  });
});

/**
 * Which workspace a row opens.
 *
 * The Team panel's rows name **sessions**; `app/workspace/[id].tsx` finds its
 * place by `Workspace.id`. So a tap has to resolve one to the other, and the
 * id it is handed may be the workspace's, a run's, or a run that has since
 * ended — which is why the lookup takes `belongsTo` as well.
 */
describe("placeOf", () => {
  const all = [
    run({ id: "s_1", workspaceId: "s_1" }),
    run({ id: "s_2", workspaceId: "s_1" }),
    run({ id: "s_3", workspaceId: "s_1" }),
  ];

  it("finds it by the workspace's own id", () => {
    expect(placeOf(places(all), "s_1")?.runs).toHaveLength(3);
  });

  it("finds it by any agent in it", () => {
    expect(placeOf(places(all), "s_3")?.runs).toHaveLength(3);
  });

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

  /** What a Team row does on tap: a member off in a workspace of its own
   *  opens that one, and a subagent sharing the manager's checkout resolves
   *  back to the workspace you are already reading — so its row stays put. */
  it("sends a member to its own place and a subagent back to the manager's", () => {
    const team = [
      run({ id: "s_lead", workspaceId: "w_lead" }),
      run({ id: "s_here", workspaceId: "w_lead", parentId: "s_lead" }),
      run({ id: "s_away", workspaceId: "w_away", parentId: "s_lead" }),
    ];
    const ps = places(team);
    expect(placeOf(ps, "s_away", "w_away")?.id).toBe("w_away");
    expect(placeOf(ps, "s_here", "w_lead")?.id).toBe("w_lead");
  });
});
