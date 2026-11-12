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
import { founder, group, isChild, lead, leadPlace, opens, placeOf, runAt } from "~/api/workspaces";

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

  /**
   * **And the same when the workspace has an id of its own**, which is every
   * workspace the control plane makes.
   *
   * The founder was looked up as `r.id === place.id`, and that can only match
   * a place filed under one of its own runs — so for a real `workspaceId` it
   * found nobody and the name fell to whichever run sorted first. `w_1` was
   * then called after the subagent that happened to be asking something: on
   * the phone that is the header over the workspace, the row in the
   * Workspaces list, and the chip on the home.
   */
  it("finds the founder when the place is not filed under one of its runs", () => {
    const all = [
      run({ id: "s_1", workspaceId: "w_1", name: "auth refactor", createdAt: "2026-11-08T09:12:00Z" }),
      run({
        id: "s_k1",
        workspaceId: "w_1",
        parentId: "s_1",
        status: "NeedsYou",
        name: "Quota band thresholds",
        createdAt: "2026-11-08T10:50:00Z",
      }),
    ];
    const place = places(all)[0];
    expect(place.runs[0].id, "the needs-you child sorts to the front").toBe("s_k1");
    expect(founder(place)?.id).toBe("s_1");
    expect(place.name).toBe("auth refactor");
  });

  /** With the founder ended and out of the list, what is left are the agents
   *  it delegated to. The oldest of them is the best the place can say for
   *  itself — the same answer the desk already gave for a place's age. */
  it("takes the oldest run still here when the founder has ended", () => {
    const all = [
      run({ id: "s_k1", workspaceId: "w_1", parentId: "s_gone", status: "NeedsYou", createdAt: "2026-11-08T10:50:00Z" }),
      run({ id: "s_k2", workspaceId: "w_1", parentId: "s_gone", createdAt: "2026-11-08T10:05:00Z" }),
    ];
    expect(founder(places(all)[0])?.id).toBe("s_k2");
  });

  /**
   * What else the founder decides: whether a workspace is a child of another.
   *
   * `leadOf` is read off the founder too, so the same failed lookup left it
   * undefined for every workspace with an id of its own — and a delegated
   * child, which is exactly the thing that has one, never drew under its lead
   * in the Workspaces list.
   */
  it("nests a delegated child under its lead, both with ids of their own", () => {
    const all = [
      run({ id: "s_1", workspaceId: "w_1", name: "Schedules.", createdAt: "2026-11-08T09:12:00Z" }),
      run({
        id: "s_2",
        workspaceId: "w_2",
        parentId: "s_1",
        name: "Schedules. / schedules-tests",
        createdAt: "2026-11-08T10:05:00Z",
      }),
    ];
    const ps = places(all);
    expect(ps.map((p) => p.id)).toEqual(["w_1", "w_2"]);
    expect(ps.map((p) => isChild(p, ps))).toEqual([false, true]);
    expect(leadPlace(ps[1], ps)?.id).toBe("w_1");
  });
});

/**
 * Which workspace an address is in.
 *
 * The Team panel's rows name **sessions**; `app/workspace/[id].tsx` finds its
 * place by `Workspace.id`. So the route has to resolve one to the other, and
 * the id it is handed may be the workspace's, a run's, or a run that has since
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

  /** Every member a Team row can name has a place the route can find: the one
   *  off in a workspace of its own lands in that, the subagent sharing the
   *  manager's checkout lands in the shared one — and `runAt` is then what
   *  keeps it from showing the manager's transcript in place of its own. */
  it("finds a place for every member a team row can name", () => {
    const team = [
      run({ id: "s_lead", workspaceId: "w_lead" }),
      run({ id: "s_here", workspaceId: "w_lead", parentId: "s_lead" }),
      run({ id: "s_away", workspaceId: "w_away", parentId: "s_lead" }),
    ];
    const ps = places(team);
    expect(placeOf(ps, "s_away", "w_away")?.id).toBe("w_away");
    expect(placeOf(ps, "s_here", "w_lead")?.id).toBe("w_lead");
    expect(runAt(placeOf(ps, "s_here")!, "s_here").id).toBe("s_here");
  });
});

/**
 * **Every row but the one you are reading opens. That is the whole rule.**
 *
 * It shipped twice with a resolution step in front of it — session to
 * workspace, and no row at all unless that landed somewhere other than here —
 * and both times rows went silently dead on a device: no chevron, no press, a
 * name under a thumb doing nothing. The roster below is every shape that
 * failed it, in the one arrangement the mock's `team` scene actually draws:
 * a manager with its subagents in its own checkout, where *every* member
 * resolved back to the workspace being read and the panel was furniture.
 *
 * So the assertion is not that the happy path yields a handler. It is that
 * exactly one row does not.
 */
describe("what a team row opens", () => {
  const manager = run({ id: "s_lead", workspaceId: "w_lead" });
  const roster = [
    /* In the manager's own checkout, with no workspace of its own. */
    run({ id: "s_here", workspaceId: "w_lead", parentId: "s_lead" }),
    /* The row you are reading. */
    run({ id: "s_reading", workspaceId: "w_lead", parentId: "s_lead" }),
    /* Delegated into a workspace of its own. */
    run({ id: "s_away", workspaceId: "w_away", parentId: "s_lead" }),
    /* Finished, and gone from the running list the places are built from. */
    run({ id: "s_gone", workspaceId: "w_lead", parentId: "s_lead", status: "Ended" }),
  ];
  const reading = roster[1];

  it("leaves exactly one row — the one you are reading — without a handler", () => {
    const panel = [manager, ...roster];
    expect(panel.filter((m) => !opens(m, reading)).map((m) => m.id)).toEqual(["s_reading"]);
  });

  it("opens each of the others at the session it names", () => {
    const panel = [manager, ...roster].filter((m) => m.id !== reading.id);
    expect(panel.map((m) => opens(m, reading))).toEqual(["s_lead", "s_here", "s_away", "s_gone"]);
  });

  it("asks nothing about where the member works", () => {
    // The shared checkout and the ended run are the two that used to resolve
    // to nowhere. Neither is a question this gets to ask any more.
    expect(opens(roster[0], reading)).toBe("s_here");
    expect(opens(roster[3], reading)).toBe("s_gone");
  });
});

/**
 * And what the route does with that address.
 *
 * Three subagents in one checkout are three rows and one workspace, so an
 * address that only named the workspace would open the same transcript three
 * times — the dead row again, wearing a navigation.
 */
describe("runAt", () => {
  const place = places([
    run({ id: "s_1", workspaceId: "w_1", createdAt: "2026-11-08T09:12:00Z" }),
    run({ id: "s_2", workspaceId: "w_1", parentId: "s_1", status: "NeedsYou", createdAt: "2026-11-08T10:50:00Z" }),
    run({ id: "s_3", workspaceId: "w_1", parentId: "s_1", createdAt: "2026-11-08T10:45:00Z" }),
  ])[0];

  it("shows the run the address names", () => {
    expect(runAt(place, "s_3").id).toBe("s_3");
    expect(runAt(place, "s_2").id).toBe("s_2");
    expect(runAt(place, "s_1").id).toBe("s_1");
  });

  /**
   * **And an address that names the place opens the place's own agent.**
   *
   * This was `lead()`, and `lead()` answers a different question: which run a
   * row's one dot and one line describe — the loudest. In a workspace with a
   * subagent working in it that is the subagent, so opening the parent from
   * any list put a child's transcript on screen, and the Team panel went on
   * to mark the child's row as the one you were reading. Which run is loudest
   * is not who the place *is*.
   */
  it("falls back to the run that founded the place", () => {
    expect(lead(place).id, "the loudest run here is a subagent").toBe("s_3");
    expect(runAt(place, "w_1").id).toBe("s_1");
    expect(runAt(place, "s_departed").id).toBe("s_1");
  });

  /**
   * A workspace whose sessions carry no `workspaceId` is filed under its
   * founding run's id, so `place.id` is a run id there — and every list in
   * the app opens a workspace by `place.id`.
   *
   * That used to be guarded against, so such an address fell through to
   * `lead()` rather than "honouring" the founder. The guard is gone with the
   * reason for it: the founder is what a list means, and here the two
   * readings of the address are the same run anyway.
   */
  it("opens a place filed under one of its runs at that run", () => {
    const solo = places([
      run({ id: "s_a", status: "NeedsYou" }),
      run({ id: "s_b", workspaceId: "s_a" }),
    ])[0];
    expect(solo.id).toBe("s_a");
    expect(lead(solo).id, "the loudest is the one working beside it").toBe("s_b");
    expect(runAt(solo, "s_a").id).toBe("s_a");
  });
});

/**
 * **The row the Team panel marks, over a round trip.**
 *
 * Reported as: *"when I open a sub workspace, and then I open the parent, the
 * sub workspace stays Active even though the displayed one is the parent."*
 * Two correct renders is not that claim — the claim is about a sequence, so
 * this walks one, by the addresses the app actually pushes.
 *
 * `panel` below is what the two routes do between them and nothing else:
 * `placeOf` for the workspace, `runAt` for the run in it, the session one
 * level up for the manager, everyone under that manager for the roster.
 * `app/workspace/[id].tsx` and `app/workspace/overview.tsx` both derive it
 * exactly so, and `ui/Overview.tsx` marks `m.id === session.id`.
 */
describe("the row the Team panel marks", () => {
  /* The mock's `team` scene, which is the shape on the report: a lead and
     three subagents in its own checkout, one asking, one working. */
  const fleet = [
    run({ id: "s_1", workspaceId: "w_1", name: "auth refactor", createdAt: "2026-11-08T09:12:00Z" }),
    run({ id: "s_k1", workspaceId: "w_1", parentId: "s_1", status: "NeedsYou", createdAt: "2026-11-08T10:50:00Z" }),
    run({ id: "s_k2", workspaceId: "w_1", parentId: "s_1", createdAt: "2026-11-08T10:45:00Z" }),
    run({ id: "s_k3", workspaceId: "w_1", parentId: "s_1", status: "HandedBack", createdAt: "2026-11-08T09:55:00Z" }),
  ];

  const panel = (address: string) => {
    const ps = places(fleet.filter((s) => s.status !== "Ended"));
    const place = placeOf(ps, address, fleet.find((s) => s.id === address)?.workspaceId)!;
    const reading = runAt(place, address);
    const manager = fleet.find((s) => s.id === reading.parentId) ?? reading;
    const rows = [manager, ...fleet.filter((s) => s.parentId === manager.id)];
    return {
      heading: place.name,
      marked: rows.filter((m) => m.id === reading.id).map((m) => m.id),
      bare: rows.filter((m) => !opens(m, reading)).map((m) => m.id),
    };
  };

  it("marks the parent's own row when a list opens the parent", () => {
    const opened = panel("w_1");
    expect(opened.marked).toEqual(["s_1"]);
    // The header over it says the same thing, which it did not either.
    expect(opened.heading).toBe("auth refactor");
  });

  it("keeps the mark on the row being read, right round the trip", () => {
    /* Address, and the row that must carry the mark. The parent arrives two
       ways — by its workspace id from a list, and by its session id from the
       manager row — and both have to land on the parent. */
    const trip: [string, string][] = [
      ["w_1", "s_1"],
      ["s_k3", "s_k3"],
      ["s_1", "s_1"],
      ["s_k2", "s_k2"],
      ["w_1", "s_1"],
    ];
    for (const [address, row] of trip) {
      expect(panel(address).marked, `opened at ${address}`).toEqual([row]);
    }
  });

  /** One row is raised and one row has no chevron, and the panel is only
   *  honest while they are the same row. */
  it("marks the row that has no chevron, and nothing else", () => {
    for (const address of ["w_1", "s_1", "s_k1", "s_k2", "s_k3"]) {
      const opened = panel(address);
      expect(opened.bare, `opened at ${address}`).toEqual(opened.marked);
      expect(opened.marked).toHaveLength(1);
    }
  });
});
