/**
 * The question has to be true of the call underneath it.
 *
 * This is the half of the *End this workspace* defect that nothing could have
 * caught. The sentence said the agents it started elsewhere stop and their
 * worktrees go; the button posted `/stop`, which is *"the workspace and the
 * branch stay; only the agent goes"*. Both clauses were false, and one of them
 * had been false on `main` before this branch added a count to it.
 *
 * The call is `destroySession(place.id, { workspace: true })` now, so every
 * clause below is something the control plane really does — see `ui/end.ts`
 * for which line of `api/sessions.rs` does it. What is left to get wrong is
 * the arithmetic and the agreement: a count that does not match what is in the
 * place, a plural that does not match the count, a floor promised where there
 * is none. So the sentence is a pure function and this is what it says.
 */
import { describe, expect, it } from "vitest";
import type { Session } from "~/api/generated/model";
import { group, type Workspace } from "~/api/workspaces";
import { endWording } from "~/ui/end";

const run = (over: Partial<Session> & { id: string }): Session =>
  ({
    name: "Quota meter rounding",
    status: "Working",
    agent: "ClaudeCode",
    repo: "acme/web",
    branch: "quota-meter",
    checkouts: [{ slug: "acme/web", branch: "quota-meter", base: "main" }],
    createdAt: "2026-11-08T10:00:00Z",
    updatedAt: "2026-11-08T10:00:00Z",
    ...over,
  }) as Session;

const place = (runs: Session[]): Workspace => {
  const { groups } = group(runs);
  return groups.flatMap(([, inRepo]) => inRepo)[0];
};

/** One agent in one checked-out workspace, which is the ordinary case. */
const one = () => place([run({ id: "s_1", workspaceId: "w_1" })]);

const clean = [{ uncommitted: 0, ahead: 0, pushed: true }];

describe("what the end question says", () => {
  it("names the place's own agents, and the floor under the question", () => {
    expect(endWording(one(), 0, clean)).toBe(
      "The agent stops. The workspace goes from the host. Nothing uncommitted is in it. The branch stays on the machine.",
    );
  });

  it("counts the agents in the place", () => {
    const two = place([
      run({ id: "s_1", workspaceId: "w_1" }),
      run({ id: "s_2", workspaceId: "w_1" }),
    ]);
    expect(endWording(two, 0, clean)).toMatch(/^2 agents stop\./);
  });

  it("does not count a run that has already ended", () => {
    const over = place([
      run({ id: "s_1", workspaceId: "w_1" }),
      run({ id: "s_2", workspaceId: "w_1", status: "Ended" }),
    ]);
    expect(endWording(over, 0, clean)).toMatch(/^The agent stops\./);
  });

  it("says the agents it started elsewhere go too, which is now true", () => {
    expect(endWording(one(), 3, clean)).toBe(
      "The agent stops, and so do the 3 agents it started elsewhere. Their workspaces go from the host with this one. Nothing uncommitted is in it. The branches stay on the machine.",
    );
  });

  it("agrees with itself about one", () => {
    expect(endWording(one(), 1, clean)).toContain("and so does the agent it started elsewhere.");
  });

  it("counts what would be lost, per thing and in the plural it is in", () => {
    expect(endWording(one(), 0, [{ uncommitted: 1, ahead: 0, pushed: true }])).toContain(
      "1 uncommitted file on quota-meter would be lost.",
    );
    expect(
      endWording(one(), 0, [
        { uncommitted: 4, ahead: 2, pushed: false },
        { uncommitted: 1, ahead: 0, pushed: true },
      ]),
    ).toContain("5 uncommitted files and 2 unpushed commits on quota-meter would be lost.");
  });

  it("counts a commit as unpushed only where there is nowhere it has gone", () => {
    /* `pushed` absent is not `pushed: false` — the worker did not say, and a
       branch with an upstream it is ahead of is not work about to be lost. */
    expect(endWording(one(), 0, [{ uncommitted: 0, ahead: 3, pushed: true }])).toContain(
      "Nothing uncommitted is in it.",
    );
    expect(endWording(one(), 0, [{ uncommitted: 0, ahead: 3, pushed: null }])).toContain(
      "Nothing uncommitted is in it.",
    );
  });

  it("says so when it could not be read, rather than saying nothing is there", () => {
    /* Absent is not zero. `CheckoutWork.uncommitted` is nullable precisely
       because a host that stopped answering used to arrive as zeros — and
       zero is what a finished workspace looks like. */
    for (const work of [null, [{ uncommitted: null, ahead: null, pushed: null }]]) {
      const said = endWording(one(), 0, work);
      expect(said).toContain("What is uncommitted there could not be read, and would be lost.");
      expect(said).not.toContain("Nothing uncommitted is in it.");
    }
  });

  it("promises no branch where there is no branch", () => {
    const bare = place([
      run({ id: "s_1", workspaceId: "w_1", branch: undefined, checkouts: [] }),
    ]);
    const said = endWording(bare, 0, clean);
    expect(said).toBe(
      "The agent stops. Nothing is checked out here, so every file in this workspace goes with it, and there is no branch to go back to.",
    );
    expect(said).not.toContain("stays on the machine");
  });

  it("still counts the family when there is nothing checked out", () => {
    const bare = place([
      run({ id: "s_1", workspaceId: "w_1", branch: undefined, checkouts: [] }),
    ]);
    expect(endWording(bare, 2, clean)).toContain("and so do the 2 agents it started elsewhere.");
  });
});
