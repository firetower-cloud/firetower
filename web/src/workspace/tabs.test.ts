import { describe, expect, it } from "vitest";
import { EMPTY, reduce, addressOf, type State, type Tab } from "./tabs";

const session = (id: string): Tab => ({
  id: addressOf.session(id),
  kind: "session",
  sessionId: id,
  face: "agent",
});

const file = (id: string, path: string): Tab => ({
  id: addressOf.file(id, path),
  kind: "file",
  sessionId: id,
  path,
});

/** Apply a sequence, so a test reads as the clicks somebody made. */
function run(...actions: Parameters<typeof reduce>[1][]): State {
  return actions.reduce(reduce, EMPTY);
}

describe("opening", () => {
  it("puts a new tab in the pane you are looking at, and focuses it", () => {
    const state = run({ do: "open", tab: session("a") });
    expect(state.tabs).toHaveLength(1);
    expect(state.active[0]).toBe("session:a");
    expect(state.split).toBe(false);
  });

  it("focuses an open tab rather than opening a second one", () => {
    const state = run(
      { do: "open", tab: session("a") },
      { do: "open", tab: session("b") },
      { do: "open", tab: session("a") },
    );
    expect(state.tabs).toHaveLength(2);
    expect(state.active[0]).toBe("session:a");
  });

  it("moves an already-open tab when asked for it beside", () => {
    // The bug this exists for: `beside` on an open tab used to split and leave
    // the tab where it was, which opened an empty half.
    const state = run(
      { do: "open", tab: session("a") },
      { do: "open", tab: file("a", "PLAN.md") },
      { do: "open", tab: file("a", "PLAN.md"), beside: true },
    );
    expect(state.split).toBe(true);
    expect(state.pane["file:a:PLAN.md"]).toBe(1);
    expect(state.active[1]).toBe("file:a:PLAN.md");
    // And the half it left is showing the session, not a hole.
    expect(state.active[0]).toBe("session:a");
  });

  it("leaves a tab alone if it is already in the other half", () => {
    const state = run(
      { do: "open", tab: session("a") },
      { do: "open", tab: file("a", "PLAN.md"), beside: true },
      { do: "focusPane", pane: 0 },
      { do: "open", tab: file("a", "PLAN.md"), beside: true },
    );
    expect(state.pane["file:a:PLAN.md"]).toBe(1);
    expect(state.tabs).toHaveLength(2);
  });
});

describe("closing", () => {
  it("leaves you looking at a neighbour rather than at nothing", () => {
    const state = run(
      { do: "open", tab: session("a") },
      { do: "open", tab: session("b") },
      { do: "close", id: "session:b" },
    );
    expect(state.active[0]).toBe("session:a");
  });

  it("takes a session's files and diffs with it", () => {
    const state = run(
      { do: "open", tab: session("a") },
      { do: "open", tab: file("a", "PLAN.md") },
      { do: "open", tab: session("b") },
      { do: "closeSession", sessionId: "a" },
    );
    expect(state.tabs.map((t) => t.id)).toEqual(["session:b"]);
  });

  it("collapses a split whose second half is now empty", () => {
    // A split held open by a hole is a half-width session for no reason.
    const state = run(
      { do: "open", tab: session("a") },
      { do: "open", tab: file("a", "PLAN.md"), beside: true },
      { do: "close", id: "file:a:PLAN.md" },
    );
    expect(state.split).toBe(false);
    expect(state.focused).toBe(0);
    expect(state.active[0]).toBe("session:a");
  });

  it("does nothing when the tab was not open", () => {
    const before = run({ do: "open", tab: session("a") });
    expect(reduce(before, { do: "close", id: "session:zzz" })).toBe(before);
  });
});

describe("splitting", () => {
  it("brings everything back to one pane on unsplit, keeping the tabs", () => {
    const state = run(
      { do: "open", tab: session("a") },
      { do: "open", tab: file("a", "PLAN.md"), beside: true },
      { do: "unsplit" },
    );
    expect(state.split).toBe(false);
    expect(state.tabs).toHaveLength(2);
    expect(Object.values(state.pane)).toEqual([0, 0]);
  });
});

describe("a session's face", () => {
  it("changes only the session it was asked about", () => {
    const state = run(
      { do: "open", tab: session("a") },
      { do: "open", tab: session("b") },
      { do: "face", id: "session:a", face: "shell" },
    );
    const faces = state.tabs.map((t) => (t.kind === "session" ? t.face : null));
    expect(faces).toEqual(["shell", "agent"]);
  });
});

describe("restoring what was open last time", () => {
  it("keeps a session opened before the store was read", () => {
    // The order this reproduces is React's: a link opens a session in a child
    // effect, and the provider restores in its own effect afterwards. Before
    // the merge, the restore silently dropped the session you followed a link
    // to and left you on whatever was open last.
    const linked = run({ do: "open", tab: session("linked") });
    const after = reduce(linked, {
      do: "restore",
      state: run({ do: "open", tab: session("a") }, { do: "open", tab: session("b") }),
    });

    expect(after.tabs.map((t) => t.sessionId).sort()).toEqual(["a", "b", "linked"]);
    // And it is the one you are looking at: it is what you just asked for.
    expect(after.active[0]).toBe("session:linked");
  });

  it("does not duplicate a session the store already had", () => {
    const linked = run({ do: "open", tab: session("a") });
    const after = reduce(linked, {
      do: "restore",
      state: run({ do: "open", tab: session("a") }, { do: "open", tab: session("b") }),
    });

    expect(after.tabs).toHaveLength(2);
  });

  it("takes the stored layout whole when nothing was opened first", () => {
    const stored = run({ do: "open", tab: session("a") }, { do: "open", tab: session("b") });
    expect(reduce(EMPTY, { do: "restore", state: stored })).toBe(stored);
  });
});
