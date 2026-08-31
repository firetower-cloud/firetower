"use client";

/**
 * What is open inside each session, and which session you are in.
 *
 * A session is a workspace. It is the container, and everything you open — the
 * conversation, a terminal, a file, a diff — happens *inside* it. So the tabs
 * belong to a session rather than to the window: picking one in the rail
 * changes which workspace you are in, and the strip shows that workspace's
 * tabs, exactly as you left them.
 *
 * This corrects a first attempt where one global strip held everything. Opening
 * a second session put it beside the first, and the strip became a pile of
 * unrelated things — two conversations, somebody's plan, a diff from a third
 * session — with nothing saying which belonged to what.
 *
 * ## Tabs are identified by what they show
 *
 * Within a session, `file:src/auth.rs` is the address and the id. Opening the
 * same file twice focuses the tab that is already there. Nothing generates a
 * key, which is also what lets the layout survive a reload without having to
 * remember what a random id meant.
 *
 * ## It lives in the browser
 *
 * How somebody has arranged their window is not a fact about the fleet, and a
 * second machine signed in as the same person should not inherit it. Storage
 * can throw — a private window, site data blocked — so every access is guarded
 * and an unreadable store means starting empty.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";

/** Which half of a split a tab is in. There are at most two. */
export type PaneIndex = 0 | 1;

export type Tab =
  /**
   * The workspace's first agent. Exactly one, and it cannot be closed.
   *
   * Its session id is the one the workspace is keyed by — a workspace takes the
   * id of the session it was split from — which is why this tab does not carry
   * one and a `run` does.
   */
  | { id: "agent"; kind: "agent" }
  /**
   * Another agent in the same workspace, with its own conversation.
   *
   * Its own session, its own socket and its own tmux on the host; what it
   * shares with the first is the directory it is working in.
   */
  | { id: string; kind: "run"; sessionId: string }
  /** A shell in the workspace. Numbered, because two is a normal thing to want. */
  | { id: string; kind: "terminal"; n: number }
  | { id: string; kind: "file"; path: string }
  | { id: string; kind: "diff"; path: string }
  /**
   * The application this session is running, on a port of this machine.
   *
   * Keyed by the port inside the workspace rather than the one bound here: the
   * local one can differ when something already had that number, and it is not
   * what somebody means when they say "the preview on 3000".
   */
  | { id: string; kind: "preview"; port: number };

/** The address of a thing inside a session, which is also its tab id. */
export const addressOf = {
  agent: () => "agent" as const,
  run: (sessionId: string) => `run:${sessionId}`,
  terminal: (n: number) => `terminal:${n}`,
  file: (path: string) => `file:${path}`,
  diff: (path: string) => `diff:${path}`,
  preview: (port: number) => `preview:${port}`,
};

/** What is open in one session. */
export type TabSet = {
  tabs: Tab[];
  pane: Record<string, PaneIndex>;
  active: [string | null, string | null];
  focused: PaneIndex;
  split: boolean;
};

export type State = {
  /** The session you are in. */
  current: string | null;
  sets: Record<string, TabSet>;
};

/** A session opens on its conversation, which is the only tab it starts with. */
export function freshSet(): TabSet {
  const agent: Tab = { id: "agent", kind: "agent" };
  return {
    tabs: [agent],
    pane: { agent: 0 },
    active: ["agent", null],
    focused: 0,
    split: false,
  };
}

export const EMPTY: State = { current: null, sets: {} };

export type Action =
  /** Go to a session, making its set if this is the first time. */
  | { do: "enter"; sessionId: string }
  | { do: "open"; tab: Tab; beside?: boolean }
  | { do: "close"; id: string }
  | { do: "focus"; id: string }
  | { do: "focusPane"; pane: PaneIndex }
  | { do: "move"; id: string; pane: PaneIndex }
  | { do: "unsplit" }
  /** A session that has gone. Its tabs go with it. */
  | { do: "forget"; sessionId: string }
  /** Step out of the workspace you are in, keeping everything it had open. */
  | { do: "leave" }
  | { do: "restore"; state: State };

export function reduce(state: State, action: Action): State {
  switch (action.do) {
    case "restore": {
      // Merged, not replaced. The store is read in the provider's effect, and
      // React runs a child's effects before its parent's — so a session entered
      // from a link, which happens in the bench below, lands *first* and would
      // be wiped by the restore that follows it. That was a deep link silently
      // dropping you on whichever session you had open last.
      const restored = action.state;
      if (!state.current) return restored;

      return {
        // Which session you are in is whatever was just asked for — a link, or
        // the address bar — because that is a choice somebody made a moment ago
        // and the store is only remembering where they were before.
        current: state.current,
        // What is *open* in each, though, is the store's. Entering a session
        // makes it a fresh set holding one tab, and that runs first: it is a
        // child's effect and this is its parent's. Letting the fresh set win
        // meant every remembered tab was thrown away on the way in, so a
        // reload came back to a workspace with only its conversation and
        // everything else silently gone.
        //
        // A session the store has never heard of still gets the fresh set,
        // because there is nothing to prefer over it.
        sets: { ...state.sets, ...restored.sets },
      };
    }

    case "enter": {
      if (state.current === action.sessionId && state.sets[action.sessionId]) return state;
      return {
        current: action.sessionId,
        sets: state.sets[action.sessionId]
          ? state.sets
          : { ...state.sets, [action.sessionId]: freshSet() },
      };
    }

    case "leave":
      // Not `forget`: coming back should find the tabs where they were left.
      // This only says "you are not in a workspace", which is what home is.
      return state.current === null ? state : { ...state, current: null };

    case "forget": {
      if (!state.sets[action.sessionId]) return state;
      const sets = { ...state.sets };
      delete sets[action.sessionId];
      return {
        sets,
        current: state.current === action.sessionId ? null : state.current,
      };
    }

    default:
      return within(state, (set) => inside(set, action));
  }
}

/** Apply a change to the session you are in, leaving the rest alone. */
function within(state: State, change: (set: TabSet) => TabSet): State {
  if (!state.current) return state;
  const set = state.sets[state.current];
  if (!set) return state;

  const next = change(set);
  if (next === set) return state;
  return { ...state, sets: { ...state.sets, [state.current]: next } };
}

/** Everything that happens to one session's tabs. */
function inside(set: TabSet, action: Action): TabSet {
  switch (action.do) {
    case "open": {
      // `beside` opens into the other half, making it if this is the first
      // time. Without it a tab lands wherever the person is already looking.
      const pane: PaneIndex = action.beside ? (set.focused === 0 ? 1 : 0) : set.focused;
      const split = set.split || action.beside === true;

      const known = set.tabs.find((t) => t.id === action.tab.id);
      if (known) {
        const at = set.pane[known.id] ?? 0;
        // Already open. Ordinarily focus it where it is — moving somebody's tab
        // because they clicked its source twice is unasked-for helpfulness.
        // `beside` is the exception, because it is a request about *position*:
        // asking for this document next to the conversation, when the document
        // is already open, has to move it. Splitting and leaving it behind
        // opens an empty half instead.
        const to: PaneIndex = action.beside && at === set.focused ? (set.focused === 0 ? 1 : 0) : at;

        const active: [string | null, string | null] = [...set.active];
        if (to !== at && active[at] === known.id) {
          active[at] =
            set.tabs.find((t) => t.id !== known.id && (set.pane[t.id] ?? 0) === at)?.id ?? null;
        }
        active[to] = known.id;

        return {
          ...set,
          pane: to === at ? set.pane : { ...set.pane, [known.id]: to },
          active,
          focused: to,
          split: split || to === 1,
        };
      }

      const active: [string | null, string | null] = [...set.active];
      active[pane] = action.tab.id;
      return {
        ...set,
        tabs: [...set.tabs, action.tab],
        pane: { ...set.pane, [action.tab.id]: pane },
        active,
        focused: pane,
        split,
      };
    }

    case "close":
      // The conversation is the session. There would be nothing left to look at
      // if it went, so it has no close control and this refuses anyway.
      return action.id === "agent" ? set : without(set, action.id);

    case "focus": {
      const at = set.pane[action.id];
      if (at === undefined) return set;
      const active: [string | null, string | null] = [...set.active];
      active[at] = action.id;
      return { ...set, active, focused: at };
    }

    case "focusPane":
      return set.focused === action.pane ? set : { ...set, focused: action.pane };

    case "move": {
      if (set.pane[action.id] === action.pane) return set;
      const active: [string | null, string | null] = [...set.active];
      const from = set.pane[action.id];
      if (active[from] === action.id) {
        // It leaves a hole behind it in the half it came from.
        active[from] =
          set.tabs.find((t) => t.id !== action.id && set.pane[t.id] === from)?.id ?? null;
      }
      active[action.pane] = action.id;
      return {
        ...set,
        pane: { ...set.pane, [action.id]: action.pane },
        active,
        focused: action.pane,
        split: true,
      };
    }

    case "unsplit": {
      // Everything comes back to the first half rather than being closed.
      const pane: Record<string, PaneIndex> = {};
      for (const t of set.tabs) pane[t.id] = 0;
      return {
        ...set,
        pane,
        active: [set.active[0] ?? set.active[1], null],
        focused: 0,
        split: false,
      };
    }

    default:
      return set;
  }
}

/** Drop one tab, and repair what was pointing at it. */
function without(set: TabSet, id: string): TabSet {
  const tabs = set.tabs.filter((t) => t.id !== id);
  if (tabs.length === set.tabs.length) return set;

  const pane: Record<string, PaneIndex> = {};
  for (const t of tabs) pane[t.id] = set.pane[t.id] ?? 0;

  const active = set.active.map((held, at) => {
    if (held && tabs.some((t) => t.id === held)) return held;
    // The nearest survivor in the same half, so closing a tab leaves you
    // looking at its neighbour rather than at nothing.
    return tabs.find((t) => pane[t.id] === at)?.id ?? null;
  }) as [string | null, string | null];

  // A half nobody is in stops existing. A split held open by a hole is a
  // half-width conversation for no reason.
  const split = set.split && tabs.some((t) => pane[t.id] === 1);
  if (!split) {
    for (const t of tabs) pane[t.id] = 0;
    return { tabs, pane, active: [active[0] ?? active[1], null], focused: 0, split: false };
  }

  return { tabs, pane, active, focused: set.focused, split };
}

/** The lowest number not already taken, so closing Terminal 1 frees the name. */
export function nextTerminal(set: TabSet): number {
  const taken = new Set(
    set.tabs.flatMap((t) => (t.kind === "terminal" ? [t.n] : [])),
  );
  let n = 1;
  while (taken.has(n)) n += 1;
  return n;
}

const Ctx = createContext<{
  state: State;
  /** What is open in the session you are in. Absent before you are in one. */
  set: TabSet | null;
  enter: (sessionId: string) => void;
  open: (tab: Tab, beside?: boolean) => void;
  close: (id: string) => void;
  focus: (id: string) => void;
  focusPane: (pane: PaneIndex) => void;
  move: (id: string, pane: PaneIndex) => void;
  unsplit: () => void;
  forget: (sessionId: string) => void;
  leave: () => void;
} | null>(null);

/** `v2` because the shape changed from one global strip to a set per session. */
const KEY = "firetower.workspace.v2";

export function Tabs({ children }: { children: ReactNode }) {
  const [state, send] = useReducer(reduce, EMPTY);

  // Read after mounting rather than as the reducer's initial value: this
  // renders on the server during a build, where there is no storage, and an
  // initial value that differed between the two halves would hydrate wrong.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(KEY);
      if (raw) send({ do: "restore", state: JSON.parse(raw) as State });
    } catch {
      // Nothing kept. Starting empty is a fine answer.
    }
  }, []);

  useEffect(() => {
    if (state === EMPTY) return;
    try {
      window.localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      // It still works for this visit, which is the part that matters.
    }
  }, [state]);

  const value = useMemo(
    () => ({
      state,
      set: state.current ? (state.sets[state.current] ?? null) : null,
      enter: (sessionId: string) => send({ do: "enter", sessionId }),
      open: (tab: Tab, beside?: boolean) => send({ do: "open", tab, beside }),
      close: (id: string) => send({ do: "close", id }),
      focus: (id: string) => send({ do: "focus", id }),
      focusPane: (pane: PaneIndex) => send({ do: "focusPane", pane }),
      move: (id: string, pane: PaneIndex) => send({ do: "move", id, pane }),
      unsplit: () => send({ do: "unsplit" }),
      forget: (sessionId: string) => send({ do: "forget", sessionId }),
      leave: () => send({ do: "leave" }),
    }),
    [state],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTabs() {
  const held = useContext(Ctx);
  if (!held) throw new Error("useTabs outside the workspace");
  return held;
}

/** The session you are in. Everything on screen is about this one. */
export function useCurrentSession(): string | null {
  return useTabs().state.current;
}

/** The tabs in one half, in order. */
export function paneTabs(set: TabSet | null, pane: PaneIndex): Tab[] {
  if (!set) return [];
  return set.tabs.filter((t) => (set.pane[t.id] ?? 0) === pane);
}

/** Convenience for the many places that just want to open a thing. */
export function useOpen() {
  const { open, set } = useTabs();
  return {
    file: useCallback(
      (path: string, beside?: boolean) =>
        open({ id: addressOf.file(path), kind: "file", path }, beside),
      [open],
    ),
    diff: useCallback(
      (path: string, beside?: boolean) =>
        open({ id: addressOf.diff(path), kind: "diff", path }, beside),
      [open],
    ),
    terminal: useCallback(() => {
      const n = set ? nextTerminal(set) : 1;
      open({ id: addressOf.terminal(n), kind: "terminal", n });
    }, [open, set]),
    preview: useCallback(
      (port: number, beside?: boolean) =>
        open({ id: addressOf.preview(port), kind: "preview", port }, beside),
      [open],
    ),
  };
}
