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
import { identity } from "~/api/identity";
import type { Session } from "~/api/generated/model";
import { destroySession } from "~/api/generated/sessions/sessions";
import { group, type Workspace } from "~/api/workspaces";
import { aimOf, useBackendId } from "~/client/http";
import { forget, remember, servers, type Connected } from "~/native/servers";
import { Alert } from "~/test/react-native.stub";
import * as hooks from "~/test/hooks";
import { endAstray, endTitle, endWording, useEndWorkspace, type Ending } from "~/ui/end";

/* The hooks come from `test/hooks.ts`, which this project uses in place of a
   renderer it does not have — see its own docblock. `useEndWorkspace` needs
   them for one ref and one effect, and the effect is the cancellation. */
vi.mock("react", async () => (await import("~/test/hooks")).react);

/**
 * The two Firetowers, **and the real registry rather than a stand-in for
 * one.**
 *
 * The same account on both, because the account is not what this is about: a
 * database restored from another — staging from production — gives two
 * separately selectable backends holding the *same* session ids, which is
 * what makes a misdirected DELETE land on a real workspace instead of failing
 * safely.
 *
 * It was two mocked functions, and that is what let the second version of
 * this defect through: a mock cannot be handed to `remember()`, so the one
 * way the registry actually moves under a request — a connection *replaced*
 * by its server id, with URL and token together — was unreachable from a
 * test. `native/servers.ts` loads in node as it is, because
 * `vitest.config.ts` stubs MMKV and the Keychain to no-ops and the rows are
 * held in memory. So every test below moves the registry through the function
 * the app moves it through.
 */
const A: Connected = { url: "https://a.example", serverId: "srv_a", org: "Ravenholm", user: "kate", addedAt: "2026-11-01T00:00:00Z" };
const B: Connected = { url: "https://b.example", serverId: "srv_b", org: "Staging", user: "kate", addedAt: "2026-11-02T00:00:00Z" };

/**
 * A's id and A's account at B's address, holding B's token: **a restored
 * database, as the registry sees it.**
 *
 * `serverId` is derived from the organisation's database id, so a copy keeps
 * it — which was the premise of the original finding and is exactly why
 * binding to the id pair reintroduced it. Nothing here is contrived: this is
 * one `remember()` of a `/bootstrap` answer from the clone.
 */
const CLONE: Connected = { ...A, url: B.url };

/** The registry, as the app would have left it. */
const connect = (...list: [Connected, string][]) => {
  for (const s of servers().slice()) forget(s.serverId);
  for (const [server, token] of list) remember(server, token);
};

/* Only three of these are imported by the generated client, and none of them
   is called here: the teardown's own cache is the one the hook was mounted
   with.

   The invalidation counts and can be held open, because it is the *second* of
   the two awaits that come after the DELETE has gone — and a flow that is
   cancelled after one of them and not the other is cancelled after neither. */
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: async () => {
      invalidated += 1;
      if (holdInvalidate) await holdInvalidate;
    },
  }),
  useQuery: () => ({}),
  useMutation: () => ({}),
}));

/**
 * An await a test can hold open and then let go of.
 *
 * The post-dispatch cancellation is entirely a question of what happens
 * *during* an await that has already sent something, so the only way to test
 * it is to stop one in the middle and move the world while it is stopped.
 */
function holding() {
  let open!: () => void;
  const until = new Promise<void>((settle) => {
    open = settle;
  });
  return { until, open };
}

/** Held while the teardown's DELETE is in flight, when a test wants it. */
let holdDelete: Promise<void> | null = null;
/** Held while the list invalidation is in flight, when a test wants it. */
let holdInvalidate: Promise<void> | null = null;
/** How many times the list was invalidated. */
let invalidated = 0;

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
      "The agent stops. The workspace goes from the host. Nothing uncommitted is in it. The branch stays on the machine. The workspace leaves the list once the host has done it.",
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
      "The agent stops, and so do the 3 agents it started elsewhere. Their workspaces go from the host with this one. Nothing uncommitted is in it. The branches stay on the machine. The workspace leaves the list once the host has done it.",
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
      "The agent stops. Nothing is checked out here, so every file in this workspace goes with it, and there is no branch to go back to. The workspace leaves the list once the host has done it.",
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
 * A 202 is a request
 * ------------------------------------------------------------------------- */

describe("an accepted teardown is not a finished one", () => {
  it("says when it happens, in both branches of the question", () => {
    /* The control plane never marks a session as going, so the row is the
       only observable there is: still listed is pending, gone is done, still
       listed later is a teardown that failed. The question is where that is
       said, because it is said before the press rather than after it. */
    const when = " The workspace leaves the list once the host has done it.";
    expect(endWording(one(), 0, clean).endsWith(when)).toBe(true);

    const bare = place([run({ id: "s_1", workspaceId: "w_1", branch: undefined, checkouts: [] })]);
    expect(endWording(bare, 0, clean).endsWith(when)).toBe(true);
  });

  it("claims nothing about the branch or the files it did not claim before", () => {
    /* The clause is additive: every sentence QA checked on a real fleet still
       reads exactly as it did. */
    expect(endWording(one(), 3, clean)).toContain(
      "The agent stops, and so do the 3 agents it started elsewhere. Their workspaces go from the host with this one. Nothing uncommitted is in it. The branches stay on the machine.",
    );
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
  let end: (place: Workspace, delegated?: number) => Promise<Ending>;

  beforeEach(() => {
    connect([A, "tok_srv_a"], [B, "tok_srv_b"]);
    sent.length = 0;
    Alert.asked.length = 0;
    whenRead = null;
    holdDelete = null;
    holdInvalidate = null;
    invalidated = 0;
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
      /* After the record, never before it: the request has gone, which is
         the whole premise of everything below. */
      if (holdDelete) await holdDelete;
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

    /* **`requested`, not `true`.** The control plane answers `202` once the
       Destroy frames are queued; nothing here waited for a worker. */
    expect(await ending).toBe("requested");
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

    expect(await ending).toBe("kept");
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
    expect(await ending).toBe("kept");
    expect(sent.map((r) => r.method)).toEqual(["GET"]);
  });

  it("sends nothing once the screen that asked has gone", async () => {
    const ending = end(one());
    await asked();
    hooks.unmount();
    Alert.answer("End it");

    expect(await ending).toBe("kept");
    expect(sent.map((r) => r.method)).toEqual(["GET"]);
  });

  it("sends nothing when Keep it is pressed, and asks nothing twice", async () => {
    const ending = end(one());
    await asked();
    Alert.answer("Keep it");

    expect(await ending).toBe("kept");
    expect(sent.map((r) => r.method)).toEqual(["GET"]);
    expect(Alert.asked).toHaveLength(1);
  });

  it("reports the control plane's own refusal rather than claiming an end", async () => {
    answers = { status: 409, body: JSON.stringify({ code: "HostUnreachable", message: "That machine is not answering." }) };
    const ending = end(one());
    await asked();
    Alert.answer("End it");

    expect(await ending).toBe("refused");
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
    const firetower = aimOf(A);
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
    const firetower = aimOf(A);
    connect([B, "tok_srv_b"]);
    useBackendId(B.serverId);

    await expect(destroySession("w_1", { workspace: true }, { firetower })).rejects.toThrow(
      "that Firetower is not connected any more",
    );
    expect(sent).toEqual([]);
  });

  /**
   * **The reviewer's second reproduction, which the first fix did not stop.**
   *
   * Same server id, same account, different address. Step for step:
   *
   * 1. The preflight reaches A.
   * 2. While the question is up, `remember()` replaces A's connection with
   *    B's URL and B's token, keeping A's id and A's username.
   * 3. *End it.*
   *
   * Bound to `[serverId, user]`, the comparison still passed and the recorded
   * traffic was a GET to A with A's token and then a **DELETE to B with B's
   * token** — the original finding, reached through the fix for it. Bound to
   * the destination, the address is part of what is compared and there is no
   * longer a pair for the clone to match.
   */
  it("sends nothing when the same id and account moved to another address", async () => {
    const ending = end(one());
    await asked();
    expect(Alert.up()?.title).toBe("End Quota meter rounding on Ravenholm?");

    remember(CLONE, "tok_srv_b");
    Alert.answer("End it");

    expect(await ending).toBe("kept");
    /* The GET, and nothing after it. */
    expect(sent).toEqual([
      { url: "https://a.example/api/v1/sessions/w_1/work", method: "GET", token: "Bearer tok_srv_a" },
    ]);
    expect(Alert.up()?.title).toBe("It did not end.");
  });

  it("asks nothing when the address moved while the work was being read", async () => {
    /* The other suspension point, moved the same way. */
    whenRead = () => remember(CLONE, "tok_srv_b");
    const ending = end(one());
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    expect(Alert.asked).toEqual([]);
    expect(await ending).toBe("kept");
    expect(sent.map((r) => r.method)).toEqual(["GET"]);
  });

  /**
   * The same case at the transport, which is the half that holds whether or
   * not the flow notices anything. A bound request whose address moved under
   * it has nowhere to go, and `here()` is not an answer to where it was for.
   */
  it("refuses a bound destination whose address moved under its id", async () => {
    const firetower = aimOf(A);
    remember(CLONE, "tok_srv_b");

    await expect(destroySession("w_1", { workspace: true }, { firetower })).rejects.toThrow(
      "that Firetower is not connected any more",
    );
    expect(sent).toEqual([]);
  });

  it("writes the address into the aim, so a moved one cannot match", () => {
    /* The encoding itself: this is what the two tests above rest on. */
    expect(aimOf(A)).not.toBe(aimOf(CLONE));
    expect(aimOf(A)).toBe(JSON.stringify([A.serverId, A.user, A.url]));
  });

  /* --------------------------------------------------------------------- *
   * The swap before the action, not during it
   * --------------------------------------------------------------------- */

  /**
   * **The reviewer's third reproduction, and the one the two fixes above do
   * not touch.**
   *
   * Both of those move the registry *while something is in flight*, so there
   * is a before and an after for a recheck to compare. Take the swap out of
   * the operation entirely and there is nothing to catch:
   *
   * 1. A workspace is read from A and retained — a row on a list, a `place`
   *    in a menu's props.
   * 2. `remember()` points A's id and account at B's address and token, with
   *    nothing in flight at all.
   * 3. *End this workspace* is pressed on the retained workspace.
   *
   * A destination read when the **action starts** is already B, so the aim,
   * the preflight, the recheck after the question and the DELETE all agree
   * with each other — and all four are about a machine that supplied none of
   * what the question says. The GET and the DELETE both reached B with B's
   * token and the answer was `requested`.
   *
   * The capture point is the fix: the destination is written down when the
   * screen that will ask is **mounted**, which is the destination whose cache
   * produced the workspace. A swap cannot get in front of that, and in the app
   * it cannot get past it either — `identity()` carries the address now, so
   * `BackendProvider` remounts and the retained screen is gone.
   */
  it("sends nothing for a workspace retained from before the address moved", async () => {
    /* Read from A, while A was still A. */
    const retained = one();
    /* One `remember()` of a clone's `/bootstrap`. Nothing is in flight. */
    remember(CLONE, "tok_srv_b");

    const ending = end(retained);

    expect(await ending).toBe("kept");
    /* **Not even the preflight.** A read on behalf of a question that will
       not be asked is still A's workspace id sent to whatever is current. */
    expect(sent).toEqual([]);
    expect(Alert.asked).toEqual([]);
  });

  /**
   * The same swap, and the half that says the binding is to a destination
   * rather than to a moment: a screen mounted *after* it is bound to the
   * clone, and acts on the clone, because the clone is what fed it.
   *
   * Note what the question would have said in the first half. `CLONE.org` is
   * `Ravenholm` — a restored database keeps the organisation's name as well as
   * its id — so the title names A's Firetower either way. **The sentence a
   * person reads cannot tell these two apart**, which is the whole reason the
   * action has to be bound to something other than the words.
   */
  it("is bound to the destination it was mounted on, not to when it is called", async () => {
    remember(CLONE, "tok_srv_b");
    expect(await end(one())).toBe("kept");
    expect(sent).toEqual([]);

    const fresh = hooks.mount(() => useEndWorkspace());
    const ending = fresh(one());
    await asked();
    Alert.answer("End it");

    expect(await ending).toBe("requested");
    expect(sent).toEqual([
      { url: "https://b.example/api/v1/sessions/w_1/work", method: "GET", token: "Bearer tok_srv_b" },
      { url: "https://b.example/api/v1/sessions/w_1?workspace=true", method: "DELETE", token: "Bearer tok_srv_b" },
    ]);
  });

  /**
   * **And the cache the question's facts come out of is keyed on that same
   * string.** `end.ts` can only bind to the destination that supplied its
   * workspace if the thing supplying workspaces is partitioned by the
   * destination — which is what `identity()` carrying the address buys, and
   * what the previous round left out. `api/identity.test.ts` holds the rest of
   * it; this is the join.
   */
  it("keys the provider and the cache on the destination the aim names", () => {
    expect(identity(A)).toBe(aimOf(A));
    expect(identity(CLONE)).not.toBe(identity(A));
  });

  /**
   * **An omitted destination and a supplied one that names nothing are two
   * different requests.**
   *
   * `aimOf` answers `""` when there was nothing to aim at, and read as falsy
   * that took the same branch as *no destination given* — so the one input
   * meaning *I do not know where this was for* resolved to whatever is
   * current. The key being there is the question; what is in it only decides
   * which answer.
   */
  it("tells an omitted destination from a supplied one that names nothing", async () => {
    await expect(destroySession("w_1", { workspace: true }, { firetower: "" })).rejects.toThrow(
      "the Firetower this was for is not known",
    );
    expect(sent).toEqual([]);

    /* Omitted still resolves, because a screen reading data is on the server
       it is on. That is the behaviour this must not take away. */
    await destroySession("w_1", { workspace: true });
    expect(sent.map((r) => r.url)).toEqual([
      "https://a.example/api/v1/sessions/w_1?workspace=true",
    ]);
  });

  it("asks nothing at all when there is no Firetower to ask about", async () => {
    /* `aimOf(undefined)` is `""`, which used to compare equal to itself and
       let the question go up about a machine the flow could not name. */
    connect();
    const ending = end(one());

    expect(await ending).toBe("kept");
    expect(Alert.asked).toEqual([]);
    expect(sent).toEqual([]);
  });

  /* ----------------------------------------------------------------------- *
   * After the DELETE, where there is nothing left to cancel
   * ----------------------------------------------------------------------- */

  /**
   * **The reviewer's second finding: the awaits after the send had no checks
   * at all.**
   *
   * Their method, and so this one's: delay each of the two independently,
   * change the identity and unmount while it is stopped, then release it.
   * Both came back `requested`, which let `WorkspaceMenu`'s continuation call
   * `onEnding()` — a global `router.back()` (`app/workspace/[id].tsx:604`) —
   * on whatever screen had replaced the one that asked.
   *
   * The DELETE cannot be called back and nothing here pretends it can. So
   * every case below asserts both halves: the request is still recorded as
   * having gone to the server it was for, **and** the answer is `orphaned`
   * rather than `requested` or `kept`. Relabelling a sent request as `kept`
   * would be a fresh version of the lie this file was written to correct.
   */
  describe("a request that outlives the screen that asked", () => {
    /** Ask, press *End it*, and stop with the DELETE in flight. */
    const sendAndStop = async () => {
      const gate = holding();
      holdDelete = gate.until;
      const ending = end(one());
      await asked();
      Alert.answer("End it");
      await vi.waitFor(() => expect(sent.map((r) => r.method)).toEqual(["GET", "DELETE"]));
      return { ending, release: gate.open };
    };

    /** The DELETE really went, to the Firetower it was asked about. */
    const theDeleteWent = () =>
      expect(sent.at(-1)).toEqual({
        url: "https://a.example/api/v1/sessions/w_1?workspace=true",
        method: "DELETE",
        token: "Bearer tok_srv_a",
      });

    it("does not navigate when the screen went while the DELETE was in flight", async () => {
      const { ending, release } = await sendAndStop();
      hooks.unmount();
      release();

      expect(await ending).toBe("orphaned");
      theDeleteWent();
    });

    it("does not navigate when the Firetower moved while the DELETE was in flight", async () => {
      const { ending, release } = await sendAndStop();
      useBackendId(B.serverId);
      release();

      expect(await ending).toBe("orphaned");
      theDeleteWent();
    });

    it("does not navigate when the address moved while the DELETE was in flight", async () => {
      /* The Blocker's own case, on the far side of the send. */
      const { ending, release } = await sendAndStop();
      remember(CLONE, "tok_srv_b");
      release();

      expect(await ending).toBe("orphaned");
      theDeleteWent();
    });

    /**
     * **The invalidation is the one that was missed by the fix as well as by
     * the first version.** It is an await like any other, and a flow cancelled
     * after one of the two and not the other is cancelled after neither.
     */
    it("does not navigate when the screen went while the list was being invalidated", async () => {
      const gate = holding();
      holdInvalidate = gate.until;
      const ending = end(one());
      await asked();
      Alert.answer("End it");
      await vi.waitFor(() => expect(invalidated).toBe(1));

      hooks.unmount();
      gate.open();

      expect(await ending).toBe("orphaned");
      theDeleteWent();
    });

    it("does not navigate when the address moved while the list was being invalidated", async () => {
      const gate = holding();
      holdInvalidate = gate.until;
      const ending = end(one());
      await asked();
      Alert.answer("End it");
      await vi.waitFor(() => expect(invalidated).toBe(1));

      remember(CLONE, "tok_srv_b");
      gate.open();

      expect(await ending).toBe("orphaned");
      theDeleteWent();
    });

    /**
     * **The list is refreshed either way.** The `QueryClient` belongs to the
     * identity the hook was mounted for, not to the screen, and the row on
     * the list is the only thing that says whether the teardown finished. So
     * the recheck is behind the invalidation rather than in front of it.
     */
    it("still invalidates the list it was mounted for, caller or no caller", async () => {
      const { ending, release } = await sendAndStop();
      hooks.unmount();
      release();

      expect(await ending).toBe("orphaned");
      expect(invalidated).toBe(1);
    });

    /**
     * A late rejection has nowhere to be shown either. *It did not end.* over
     * a workspace the reader did not ask about is worse than silence — and
     * `refused` is still the truth, so that is still what comes back.
     */
    it("shows no alert for a refusal that lands after the screen has gone", async () => {
      answers = {
        status: 409,
        body: JSON.stringify({ code: "HostUnreachable", message: "That machine is not answering." }),
      };
      const { ending, release } = await sendAndStop();
      hooks.unmount();
      release();

      expect(await ending).toBe("refused");
      expect(Alert.asked.filter((a) => a.title === "It did not end.")).toEqual([]);
    });

    it("still shows a refusal to the screen that asked for it", async () => {
      /* The half that must not be lost: a reader who is still there is still
         told, in the control plane's own words. */
      answers = {
        status: 409,
        body: JSON.stringify({ code: "HostUnreachable", message: "That machine is not answering." }),
      };
      const { ending, release } = await sendAndStop();
      release();

      expect(await ending).toBe("refused");
      expect(Alert.up()?.title).toBe("It did not end.");
      expect(Alert.up()?.body).toBe("That machine is not answering.");
    });

    it("still answers requested, and navigates, when the caller is still there", async () => {
      /* The truthful path, unchanged: a delay is not a cancellation. */
      const { ending, release } = await sendAndStop();
      release();

      expect(await ending).toBe("requested");
      expect(invalidated).toBe(1);
    });
  });

  it("leaves the server out of the question when the phone holds one", async () => {
    connect([A, "tok_srv_a"]);
    const ending = end(one());
    await asked();
    expect(Alert.up()?.title).toBe("End Quota meter rounding?");
    Alert.answer("Keep it");
    await ending;
  });
});
