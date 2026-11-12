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
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "~/api/generated/model";
import { destroySession } from "~/api/generated/sessions/sessions";
import { group, type Workspace } from "~/api/workspaces";
import { useBackendId } from "~/client/http";
import { Alert } from "~/test/react-native.stub";
import * as hooks from "~/test/hooks";
import { endAstray, endTitle, endWording, useEndWorkspace } from "~/ui/end";

/* The hooks come from `test/hooks.ts`, which this project uses in place of a
   renderer it does not have — see its own docblock. `useEndWorkspace` needs
   them for one ref and one effect, and the effect is the cancellation. */
vi.mock("react", async () => (await import("~/test/hooks")).react);

/* The two Firetowers. The same account on both, because the account is not
   what this is about: a database restored from another — staging from
   production — gives two separately selectable backends holding the *same*
   session ids, which is what makes a misdirected DELETE land on a real
   workspace instead of failing safely. */
const A = { url: "https://a.example", serverId: "srv_a", org: "Ravenholm", user: "kate", addedAt: "2026-11-01T00:00:00Z" };
const B = { url: "https://b.example", serverId: "srv_b", org: "Staging", user: "kate", addedAt: "2026-11-02T00:00:00Z" };

let registry = [A, B];

vi.mock("~/native/servers", () => ({
  servers: () => registry,
  tokenFor: (serverId: string) => `tok_${serverId}`,
}));

/* Only three of these are imported by the generated client, and none of them
   is called here: the teardown's own cache is the one the hook was mounted
   with. */
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
  useQuery: () => ({}),
  useMutation: () => ({}),
}));

/** Every request the transport was handed, in order. */
const sent: { url: string; method: string; token: string | null }[] = [];
/** Run the moment the preflight read lands — one of the two places to move. */
let whenRead: (() => void) | null = null;
/** What the control plane answers the teardown with. */
let answers: { status: number; body: string } = { status: 202, body: "" };

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

/* ------------------------------------------------------------------------- *
 * The target
 * ------------------------------------------------------------------------- */

describe("which workspace the question is about", () => {
  it("names it, and the Firetower when there is more than one", () => {
    expect(endTitle(one(), "Ravenholm")).toBe("End Quota meter rounding on Ravenholm?");
  });

  it("leaves the server out when there is nothing to confuse it with", () => {
    expect(endTitle(one(), null)).toBe("End Quota meter rounding?");
  });

  it("claims no cause when the answer arrived somewhere else", () => {
    /* Either the Firetower moved or the screen is gone, and the two are
       usually one event. It says what is known and where to ask again. */
    expect(endAstray(one(), "Ravenholm")).toBe(
      "Nothing was sent. Quota meter rounding is still on Ravenholm — ask again from there.",
    );
    expect(endAstray(one(), null)).toBe("Nothing was sent. Quota meter rounding was not ended.");
  });
});

/**
 * The reviewer's own reproduction, with their own method: the real hook, the
 * real generated client, the real `http`, and a mocked transport. Before the
 * fix the GET went to A and the DELETE went to B.
 */
describe("a teardown goes to the Firetower it was asked about", () => {
  let end: (place: Workspace, delegated?: number) => Promise<boolean>;

  beforeEach(() => {
    registry = [A, B];
    sent.length = 0;
    Alert.asked.length = 0;
    whenRead = null;
    answers = { status: 202, body: "" };
    useBackendId(A.serverId);

    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      sent.push({
        url: String(url),
        method,
        token: new Headers(init.headers).get("authorization"),
      });
      if (method === "GET") {
        whenRead?.();
        return new Response(JSON.stringify(clean), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(answers.body || null, { status: answers.status });
    }) as unknown as typeof fetch;

    end = hooks.mount(() => useEndWorkspace());
  });

  /** The question, once it is on screen. */
  const asked = () => vi.waitFor(() => expect(Alert.up()?.buttons).toBeTruthy());

  it("reads and ends on the one server, and names it in the question", async () => {
    const ending = end(one());
    await asked();
    expect(Alert.up()?.title).toBe("End Quota meter rounding on Ravenholm?");
    Alert.answer("End it");

    expect(await ending).toBe(true);
    expect(sent).toEqual([
      { url: "https://a.example/api/v1/sessions/w_1/work", method: "GET", token: "Bearer tok_srv_a" },
      { url: "https://a.example/api/v1/sessions/w_1?workspace=true", method: "DELETE", token: "Bearer tok_srv_a" },
    ]);
  });

  it("sends nothing when the Firetower changed while the question was open", async () => {
    const ending = end(one());
    await asked();
    /* The switch remounts everything under `BackendProvider`; the question is
       a native window and stays on screen with A's facts in it. */
    useBackendId(B.serverId);
    Alert.answer("End it");

    expect(await ending).toBe(false);
    expect(sent.filter((r) => r.method === "DELETE")).toEqual([]);
    expect(Alert.up()?.title).toBe("It did not end.");
    expect(Alert.up()?.body).toContain("still on Ravenholm");
  });

  it("asks nothing at all when it moved while the work was being read", async () => {
    /* The first of the two suspension points. Rechecking only after the
       question is what leaves this one open. */
    whenRead = () => useBackendId(B.serverId);
    const ending = end(one());
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(Alert.asked).toEqual([]);
    expect(await ending).toBe(false);
    expect(sent.map((r) => r.method)).toEqual(["GET"]);
  });

  it("sends nothing once the screen that asked has gone", async () => {
    const ending = end(one());
    await asked();
    hooks.unmount();
    Alert.answer("End it");

    expect(await ending).toBe(false);
    expect(sent.map((r) => r.method)).toEqual(["GET"]);
  });

  it("sends nothing when Keep it is pressed, and asks nothing twice", async () => {
    const ending = end(one());
    await asked();
    Alert.answer("Keep it");

    expect(await ending).toBe(false);
    expect(sent.map((r) => r.method)).toEqual(["GET"]);
    expect(Alert.asked).toHaveLength(1);
  });

  it("reports the control plane's own refusal rather than claiming an end", async () => {
    answers = { status: 409, body: JSON.stringify({ code: "HostUnreachable", message: "That machine is not answering." }) };
    const ending = end(one());
    await asked();
    Alert.answer("End it");

    expect(await ending).toBe(false);
    expect(Alert.up()?.title).toBe("It did not end.");
    expect(Alert.up()?.body).toBe("That machine is not answering.");
  });

  /**
   * The binding on its own, which is the half that does not depend on the
   * flow noticing anything. A request that names its Firetower goes there
   * whatever the app has done since; one that does not goes wherever the app
   * is now — which is the defect, stated as a test rather than as prose.
   */
  it("cannot be redirected by a server switch once it names its target", async () => {
    const firetower = JSON.stringify([A.serverId, A.user]);
    useBackendId(B.serverId);

    await destroySession("w_1", { workspace: true }, { firetower });
    await destroySession("w_1", { workspace: true });

    expect(sent.map((r) => r.url)).toEqual([
      "https://a.example/api/v1/sessions/w_1?workspace=true",
      "https://b.example/api/v1/sessions/w_1?workspace=true",
    ]);
    expect(sent.map((r) => r.token)).toEqual(["Bearer tok_srv_a", "Bearer tok_srv_b"]);
  });

  it("refuses a named Firetower that has been signed out of, rather than sending it elsewhere", async () => {
    const firetower = JSON.stringify([A.serverId, A.user]);
    registry = [B];
    useBackendId(B.serverId);

    await expect(destroySession("w_1", { workspace: true }, { firetower })).rejects.toThrow(
      "that Firetower is not connected any more",
    );
    expect(sent).toEqual([]);
  });

  it("leaves the server out of the question when the phone holds one", async () => {
    registry = [A];
    const ending = end(one());
    await asked();
    expect(Alert.up()?.title).toBe("End Quota meter rounding?");
    Alert.answer("Keep it");
    await ending;
  });
});
