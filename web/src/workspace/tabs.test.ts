import { describe, expect, it } from "vitest";
import {
  EMPTY,
  addressOf,
  freshSet,
  nextTerminal,
  reduce,
  type Action,
  type State,
  type Tab,
} from "./tabs";

const file = (path: string): Tab => ({ id: addressOf.file(path), kind: "file", path });
const terminal = (n: number): Tab => ({ id: addressOf.terminal(n), kind: "terminal", n });

/** Apply a sequence, so a test reads as the clicks somebody made. */
function run(...actions: Action[]): State {
  return actions.reduce(reduce, EMPTY);
}

/** What is open in the session you are in. */
function here(state: State) {
  return state.current ? state.sets[state.current] : null;
}

describe("a session is the container", () => {
  it("opens on its conversation and nothing else", () => {
    const state = run({ do: "enter", sessionId: "a" });
    expect(state.current).toBe("a");
    expect(here(state)?.tabs.map((t) => t.kind)).toEqual(["agent"]);
    expect(here(state)?.active[0]).toBe("agent");
  });

  it("gives each session its own tabs, kept while you are elsewhere", () => {
    // The whole point of the change: entering another session must not add to
    // a pile, and coming back must find things where they were left.
    const state = run(
      { do: "enter", sessionId: "a" },
      { do: "open", tab: file("PLAN.md") },
      { do: "open", tab: terminal(1) },
      { do: "enter", sessionId: "b" },
    );

    expect(here(state)?.tabs.map((t) => t.kind)).toEqual(["agent"]);
    expect(state.sets["a"].tabs.map((t) => t.id)).toEqual([
      "agent",
      "file:PLAN.md",
      "terminal:1",
    ]);

    const back = reduce(state, { do: "enter", sessionId: "a" });
    expect(back.sets["a"].active[0]).toBe("terminal:1");
  });

  it("opens into the session you are in, never another", () => {
    const state = run(
      { do: "enter", sessionId: "a" },
      { do: "enter", sessionId: "b" },
      { do: "open", tab: file("only-b.ts") },
    );
    expect(state.sets["a"].tabs).toHaveLength(1);
    expect(state.sets["b"].tabs).toHaveLength(2);
  });

  it("re-entering the session you are in changes nothing", () => {
    const before = run({ do: "enter", sessionId: "a" }, { do: "open", tab: file("x.ts") });
    expect(reduce(before, { do: "enter", sessionId: "a" })).toBe(before);
  });

  it("does nothing at all before you are in a session", () => {
    expect(reduce(EMPTY, { do: "open", tab: file("x.ts") })).toBe(EMPTY);
  });

  it("forgets a session's tabs when it is gone", () => {
    const state = run(
      { do: "enter", sessionId: "a" },
      { do: "open", tab: file("x.ts") },
      { do: "forget", sessionId: "a" },
    );
    expect(state.sets["a"]).toBeUndefined();
    expect(state.current).toBeNull();
  });
});

describe("the conversation cannot be closed", () => {
  it("refuses, because closing it would leave the session with nothing", () => {
    const before = run({ do: "enter", sessionId: "a" });
    expect(reduce(before, { do: "close", id: "agent" })).toBe(before);
  });

  it("closes everything else, leaving you on a neighbour", () => {
    const state = run(
      { do: "enter", sessionId: "a" },
      { do: "open", tab: file("x.ts") },
      { do: "close", id: "file:x.ts" },
    );
    expect(here(state)?.tabs.map((t) => t.id)).toEqual(["agent"]);
    expect(here(state)?.active[0]).toBe("agent");
  });
});

describe("terminals", () => {
  it("takes the lowest free number, so closing one frees its name", () => {
    const set = run(
      { do: "enter", sessionId: "a" },
      { do: "open", tab: terminal(1) },
      { do: "open", tab: terminal(2) },
    );
    expect(nextTerminal(here(set)!)).toBe(3);

    const gone = reduce(set, { do: "close", id: "terminal:1" });
    expect(nextTerminal(here(gone)!)).toBe(1);
  });

  it("starts at one in a session that has none", () => {
    expect(nextTerminal(freshSet())).toBe(1);
  });
});

describe("splitting, inside one session", () => {
  it("moves an already-open tab when asked for it beside", () => {
    // `beside` on an open tab used to split and leave the tab where it was,
    // which opened an empty half.
    const state = run(
      { do: "enter", sessionId: "a" },
      { do: "open", tab: file("PLAN.md") },
      { do: "open", tab: file("PLAN.md"), beside: true },
    );
    expect(here(state)?.split).toBe(true);
    expect(here(state)?.pane["file:PLAN.md"]).toBe(1);
    // And the half it left is showing the conversation, not a hole.
    expect(here(state)?.active[0]).toBe("agent");
  });

  it("collapses a split whose second half is now empty", () => {
    const state = run(
      { do: "enter", sessionId: "a" },
      { do: "open", tab: file("PLAN.md"), beside: true },
      { do: "close", id: "file:PLAN.md" },
    );
    expect(here(state)?.split).toBe(false);
    expect(here(state)?.active[0]).toBe("agent");
  });

  it("brings everything back on unsplit, keeping the tabs", () => {
    const state = run(
      { do: "enter", sessionId: "a" },
      { do: "open", tab: file("PLAN.md"), beside: true },
      { do: "unsplit" },
    );
    expect(here(state)?.split).toBe(false);
    expect(here(state)?.tabs).toHaveLength(2);
    expect(Object.values(here(state)!.pane)).toEqual([0, 0]);
  });

  it("splits one session without touching another's layout", () => {
    const state = run(
      { do: "enter", sessionId: "a" },
      { do: "open", tab: file("PLAN.md"), beside: true },
      { do: "enter", sessionId: "b" },
    );
    expect(state.sets["a"].split).toBe(true);
    expect(state.sets["b"].split).toBe(false);
  });
});

describe("restoring what was open last time", () => {
  it("keeps the session entered before the store was read", () => {
    // The order this reproduces is React's: a link enters a session in a child
    // effect, and the provider restores in its own effect afterwards. Before
    // the merge, the restore dropped the session you followed a link to.
    const linked = run({ do: "enter", sessionId: "linked" });
    const after = reduce(linked, {
      do: "restore",
      state: run({ do: "enter", sessionId: "a" }, { do: "open", tab: file("x.ts") }),
    });

    expect(after.current).toBe("linked");
    // And the remembered session's tabs are still there to go back to.
    expect(after.sets["a"].tabs).toHaveLength(2);
    expect(after.sets["linked"]).toBeDefined();
  });

  it("takes the stored state whole when nothing was entered first", () => {
    const stored = run({ do: "enter", sessionId: "a" }, { do: "open", tab: file("x.ts") });
    expect(reduce(EMPTY, { do: "restore", state: stored })).toBe(stored);
  });
});
