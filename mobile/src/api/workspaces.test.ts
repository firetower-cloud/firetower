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
import { group, lead } from "~/api/workspaces";

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
