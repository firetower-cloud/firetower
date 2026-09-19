/**
 * What the island is told, and what it is not.
 *
 * The pill is a third screen drawing the same fleet as the rail and the fleet
 * page, and `Fleet.tsx` already warns what that costs: a second way of drawing
 * the same rows is how two screens drift apart. So these are mostly tests that
 * the island agrees with the app — same grouping, same idea of what "waiting"
 * means, same order — rather than tests that it looks nice.
 */
import { describe, expect, it } from "vitest";
import type { Session, SessionStatus } from "~/api/generated/model";
import type { Backend, Fleet } from "~/fleet";
import { islandState, modeOf, onScreen } from "./state";

const backend = (id: string, mark: string, reach: Backend["reach"] = "live"): Backend => ({
  id,
  org: mark,
  user: "kevin",
  mark,
  url: `https://${id}.example`,
  reach,
});

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const session = (over: Partial<Session> & { status: SessionStatus }): Session =>
  ({
    id: "s_1",
    name: "auth middleware",
    agent: "ClaudeCode",
    repo: "westlabs/ledger",
    workspaceId: "w_1",
    createdAt: ago(28),
    ...over,
  }) as unknown as Session;

const fleet = (backendOf: Backend, sessions: Session[]): Fleet => ({
  backend: backendOf,
  sessions,
  error: null,
});

describe("what lands on the pill", () => {
  it("puts something blocked on you in the waiting list", () => {
    const state = islandState([fleet(backend("a", "W"), [session({ status: "NeedsYou" })])]);
    expect(state.waiting).toHaveLength(1);
    expect(state.working).toHaveLength(0);
    expect(state.waiting[0]).toMatchObject({ name: "auth middleware", repo: "ledger", mark: "W" });
  });

  it("puts something still running in the other one", () => {
    const state = islandState([fleet(backend("a", "W"), [session({ status: "Working" })])]);
    expect(state.working).toHaveLength(1);
    expect(state.waiting).toHaveLength(0);
  });

  /* `NEEDS_YOU` is three statuses, and all three mean the same thing to the
     person glancing at the island: it stopped being useful without you. */
  it.each(["NeedsYou", "HandedBack", "Failed"] as const)("counts %s as waiting", (status) => {
    expect(islandState([fleet(backend("a", "W"), [session({ status })])]).waiting).toHaveLength(1);
  });

  it("ignores a workspace that is up and idle", () => {
    const state = islandState([fleet(backend("a", "W"), [session({ status: "Ready" })])]);
    expect(state.waiting).toHaveLength(0);
    expect(state.working).toHaveLength(0);
  });

  it("ignores a session that is over", () => {
    const state = islandState([fleet(backend("a", "W"), [session({ status: "Ended" })])]);
    expect(state.working).toHaveLength(0);
  });

  /* A workspace is a checkout with any number of agents in it, and the app
     draws it as one row. Two agents in one checkout must not become two rows
     out here, or the count on the pill disagrees with the count in the app. */
  it("draws two agents in one workspace as one row", () => {
    const state = islandState([
      fleet(backend("a", "W"), [
        session({ id: "s_1", status: "NeedsYou" }),
        session({ id: "s_2", status: "NeedsYou", agent: "Codex" }),
      ]),
    ]);
    expect(state.waiting).toHaveLength(1);
  });

  /* `doing()` answers for the *place*, and a workspace with one agent still
     going is working even if another agent in it has stopped to ask. The
     island inherits that on purpose: disagreeing would mean the pill says
     "waiting" about a row the app draws as busy. */
  it("follows the app when one agent asks and another is still going", () => {
    const state = islandState([
      fleet(backend("a", "W"), [
        session({ id: "s_1", status: "NeedsYou" }),
        session({ id: "s_2", status: "Working", agent: "Codex" }),
      ]),
    ]);
    expect(state.waiting).toHaveLength(0);
    expect(state.working).toHaveLength(1);
  });
});

describe("more than one server", () => {
  it("merges them, each keeping its own monogram", () => {
    const state = islandState([
      fleet(backend("a", "W"), [session({ status: "NeedsYou" })]),
      fleet(backend("b", "N"), [session({ status: "NeedsYou", name: "rate limiter" })]),
    ]);
    expect(state.waiting.map((r) => r.mark).sort()).toEqual(["N", "W"]);
    expect(state.servers).toBe(2);
  });

  /* The same workspace id on two backends is two different workspaces, and a
     key that collided would drop one of them out of the list without a trace. */
  it("keeps rows apart when two servers use the same workspace id", () => {
    const state = islandState([
      fleet(backend("a", "W"), [session({ status: "NeedsYou" })]),
      fleet(backend("b", "N"), [session({ status: "NeedsYou" })]),
    ]);
    expect(new Set(state.waiting.map((r) => r.key)).size).toBe(2);
  });

  /* Rows from a dark server do not disappear. A list that empties itself when
     the VPN drops reads as work being lost, which is the rule `STYLE.md` sets
     for the app and there is no reason the island gets to break it. */
  it("keeps showing a server that is not answering, marked stale", () => {
    const state = islandState([
      fleet(backend("a", "W", "unreachable"), [session({ status: "NeedsYou" })]),
    ]);
    expect(state.waiting).toHaveLength(1);
    expect(state.waiting[0].stale).toBe(true);
    expect(state.unreachable).toBe(1);
  });
});

describe("the order", () => {
  /* Newest first, which is how the app sorts. Longest-waiting-first is the
     more tempting sort and it is the one that makes the two disagree. */
  it("is newest first, like every other list of the same rows", () => {
    const state = islandState([
      fleet(backend("a", "W"), [
        session({ id: "s_1", workspaceId: "w_old", name: "old", status: "NeedsYou", createdAt: ago(300) }),
        session({ id: "s_2", workspaceId: "w_new", name: "new", status: "NeedsYou", createdAt: ago(3) }),
      ]),
    ]);
    expect(state.waiting.map((r) => r.name)).toEqual(["new", "old"]);
  });
});

describe("which of the three states it is in", () => {
  it("is dormant with nothing to say", () => {
    expect(modeOf(islandState([]))).toBe("dormant");
  });

  it("is ambient while something is running", () => {
    expect(modeOf(islandState([fleet(backend("a", "W"), [session({ status: "Working" })])]))).toBe(
      "ambient",
    );
  });

  /* Ember outranks everything. One thing waiting while ten are running is an
     ember pill, because the one is the only one you can do anything about. */
  it("is demand as soon as anything is waiting, however much else is running", () => {
    const state = islandState([
      fleet(backend("a", "W"), [
        session({ id: "s_1", workspaceId: "w_1", status: "Working" }),
        session({ id: "s_2", workspaceId: "w_2", status: "NeedsYou" }),
      ]),
    ]);
    expect(modeOf(state)).toBe("demand");
  });
});

describe("hiding it", () => {
  it("takes it off screen while nothing is happening", () => {
    expect(onScreen(true, "dormant")).toBe(false);
    expect(onScreen(true, "ambient")).toBe(false);
  });

  /* The one that matters. "Hide until something needs you" is a choice about
     the quiet states; if it could also suppress ember it would be an off
     switch wearing a reassuring label. */
  it("brings it straight back when something needs you", () => {
    expect(onScreen(true, "demand")).toBe(true);
  });

  it("leaves it alone when nothing was hidden", () => {
    expect(onScreen(false, "dormant")).toBe(true);
  });
});
