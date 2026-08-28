"use client";

/**
 * What is open, and where.
 *
 * The interface used to be one session per page: you navigated away to look at
 * anything else, and two agents could not be on screen at once. This is the
 * state that replaces that — a set of open tabs across one or two panes, which
 * is the whole difference between reading a session and working across a fleet.
 *
 * ## Tabs are identified by what they show, not by when they were opened
 *
 * Opening the same file twice focuses the tab that is already there rather than
 * making a second one. So the id *is* the address: `file:s_abc:src/auth.rs`.
 * Nothing generates a key, which also means the layout survives a reload
 * without having to remember which random id meant what.
 *
 * ## It lives in the browser
 *
 * Which tabs somebody has open is a fact about this browser mid-thought, not a
 * fact about the fleet — a second machine signed in as the same person should
 * not inherit them. Storage can throw (a private window, site data blocked), so
 * every access is guarded and an unreadable store simply means starting empty.
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

/** What a session tab is currently showing. A toggle inside the tab, not two tabs. */
export type SessionFace = "agent" | "shell";

export type Tab =
  | { id: string; kind: "session"; sessionId: string; face: SessionFace }
  | { id: string; kind: "file"; sessionId: string; path: string }
  | { id: string; kind: "diff"; sessionId: string; path: string };

/** The address of a thing, which is also its tab id. */
export const addressOf = {
  session: (sessionId: string) => `session:${sessionId}`,
  file: (sessionId: string, path: string) => `file:${sessionId}:${path}`,
  diff: (sessionId: string, path: string) => `diff:${sessionId}:${path}`,
};

export type State = {
  /** Every open tab, in the order they were opened. */
  tabs: Tab[];
  /** Which pane each tab is in. */
  pane: Record<string, PaneIndex>;
  /** The tab on top in each pane. */
  active: [string | null, string | null];
  /** Which pane keystrokes and the inspector belong to. */
  focused: PaneIndex;
  /** Whether the second pane exists at all. */
  split: boolean;
};

/** Nothing open. Exported so the tests can start from the same place. */
export const EMPTY: State = { tabs: [], pane: {}, active: [null, null], focused: 0, split: false };

export type Action =
  | { do: "open"; tab: Tab; beside?: boolean }
  | { do: "close"; id: string }
  | { do: "closeSession"; sessionId: string }
  | { do: "focus"; id: string }
  | { do: "focusPane"; pane: PaneIndex }
  | { do: "face"; id: string; face: SessionFace }
  | { do: "move"; id: string; pane: PaneIndex }
  | { do: "unsplit" }
  | { do: "restore"; state: State };

export function reduce(state: State, action: Action): State {
  switch (action.do) {
    case "restore": {
      // Merged, not replaced. The store is read in the provider's effect, and
      // React runs a child's effects before its parent's — so a session opened
      // from a link, which happens in the bench below, lands *first* and would
      // be wiped by the restore that follows it. That was a deep link silently
      // dropping you on whichever tab you happened to have open last.
      //
      // What was already here wins: it is what somebody just asked for, and
      // the restore is only remembering what they had before.
      const restored = action.state;
      const extra = state.tabs.filter((t) => !restored.tabs.some((r) => r.id === t.id));
      if (extra.length === 0) return restored;

      const pane = { ...restored.pane };
      for (const t of extra) pane[t.id] = 0;

      return {
        ...restored,
        tabs: [...restored.tabs, ...extra],
        pane,
        // The newly opened one is what to look at, in the pane it landed in.
        active: [extra[extra.length - 1].id, restored.active[1]],
        focused: 0,
      };
    }

    case "open": {
      // `beside` opens into the other pane, creating it if this is the first
      // time. Without it a tab lands wherever the person is already looking,
      // which is what makes clicking a file feel like navigation rather than
      // like rearranging the room.
      const pane: PaneIndex = action.beside ? (state.focused === 0 ? 1 : 0) : state.focused;
      const split = state.split || action.beside === true;

      const known = state.tabs.find((t) => t.id === action.tab.id);
      if (known) {
        const at = state.pane[known.id] ?? 0;
        // Already open. Ordinarily focus it where it is — moving somebody's tab
        // because they clicked its source a second time is the kind of
        // helpfulness nobody asked for. `beside` is the exception, because it
        // is a request about *position*: asking for this document next to the
        // conversation, when the document is already open, has to move it.
        // Splitting and leaving it behind opens an empty half instead.
        const to: PaneIndex =
          action.beside && at === state.focused ? (state.focused === 0 ? 1 : 0) : at;

        const active: [string | null, string | null] = [...state.active];
        if (to !== at && active[at] === known.id) {
          // It leaves a hole behind it in the pane it came from.
          active[at] =
            state.tabs.find((t) => t.id !== known.id && (state.pane[t.id] ?? 0) === at)?.id ?? null;
        }
        active[to] = known.id;

        return {
          ...state,
          pane: to === at ? state.pane : { ...state.pane, [known.id]: to },
          active,
          focused: to,
          split: split || to === 1,
        };
      }

      const active: [string | null, string | null] = [...state.active];
      active[pane] = action.tab.id;
      return {
        ...state,
        tabs: [...state.tabs, action.tab],
        pane: { ...state.pane, [action.tab.id]: pane },
        active,
        focused: pane,
        split,
      };
    }

    case "close":
      return without(state, (t) => t.id === action.id);

    case "closeSession":
      // Closing a session closes what belonged to it. Its files and diffs are
      // views onto a workspace that is no longer on screen, and leaving them
      // behind orphans a tab whose header names a session you just dismissed.
      return without(state, (t) => t.sessionId === action.sessionId);

    case "focus": {
      const at = state.pane[action.id];
      if (at === undefined) return state;
      const active: [string | null, string | null] = [...state.active];
      active[at] = action.id;
      return { ...state, active, focused: at };
    }

    case "focusPane":
      return state.focused === action.pane ? state : { ...state, focused: action.pane };

    case "face":
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id === action.id && t.kind === "session" ? { ...t, face: action.face } : t,
        ),
      };

    case "move": {
      if (state.pane[action.id] === action.pane) return state;
      const active: [string | null, string | null] = [...state.active];
      // It leaves a hole behind it in the pane it came from.
      const from = state.pane[action.id];
      if (active[from] === action.id) {
        active[from] = state.tabs.find((t) => t.id !== action.id && state.pane[t.id] === from)?.id ?? null;
      }
      active[action.pane] = action.id;
      return {
        ...state,
        pane: { ...state.pane, [action.id]: action.pane },
        active,
        focused: action.pane,
        split: true,
      };
    }

    case "unsplit": {
      // Everything comes back to the first pane rather than being closed.
      const pane: Record<string, PaneIndex> = {};
      for (const t of state.tabs) pane[t.id] = 0;
      return {
        ...state,
        pane,
        active: [state.active[0] ?? state.active[1], null],
        focused: 0,
        split: false,
      };
    }
  }
}

/** Drop every tab matching `gone`, and repair what was pointing at them. */
function without(state: State, gone: (t: Tab) => boolean): State {
  const tabs = state.tabs.filter((t) => !gone(t));
  if (tabs.length === state.tabs.length) return state;

  const pane: Record<string, PaneIndex> = {};
  for (const t of tabs) pane[t.id] = state.pane[t.id] ?? 0;

  const active = state.active.map((id, at) => {
    if (id && tabs.some((t) => t.id === id)) return id;
    // The nearest survivor in the same pane, so closing a tab leaves you
    // looking at its neighbour rather than at nothing.
    return tabs.find((t) => pane[t.id] === at)?.id ?? null;
  }) as [string | null, string | null];

  // A pane nobody is in stops existing. A split held open by a hole is a
  // half-width session for no reason.
  const split = state.split && tabs.some((t) => pane[t.id] === 1);
  if (!split) {
    for (const t of tabs) pane[t.id] = 0;
    return { tabs, pane, active: [active[0] ?? active[1], null], focused: 0, split: false };
  }

  return { tabs, pane, active, focused: state.focused, split };
}

const Ctx = createContext<{
  state: State;
  open: (tab: Tab, beside?: boolean) => void;
  close: (id: string) => void;
  closeSession: (sessionId: string) => void;
  focus: (id: string) => void;
  focusPane: (pane: PaneIndex) => void;
  face: (id: string, face: SessionFace) => void;
  move: (id: string, pane: PaneIndex) => void;
  unsplit: () => void;
} | null>(null);

const KEY = "firetower.workspace";

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
      open: (tab: Tab, beside?: boolean) => send({ do: "open", tab, beside }),
      close: (id: string) => send({ do: "close", id }),
      closeSession: (sessionId: string) => send({ do: "closeSession", sessionId }),
      focus: (id: string) => send({ do: "focus", id }),
      focusPane: (pane: PaneIndex) => send({ do: "focusPane", pane }),
      face: (id: string, f: SessionFace) => send({ do: "face", id, face: f }),
      move: (id: string, pane: PaneIndex) => send({ do: "move", id, pane }),
      unsplit: () => send({ do: "unsplit" }),
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

/**
 * The session the inspector should be describing.
 *
 * Whatever is on top of the focused pane — and if that is a file or a diff, the
 * session it came from. Looking at a diff should not empty the panel that
 * explains where the diff is from.
 */
export function useFocusedSession(): string | null {
  const { state } = useTabs();
  const id = state.active[state.focused] ?? state.active[state.focused === 0 ? 1 : 0];
  return state.tabs.find((t) => t.id === id)?.sessionId ?? null;
}

/** The tabs in one pane, in order. */
export function paneTabs(state: State, pane: PaneIndex): Tab[] {
  return state.tabs.filter((t) => (state.pane[t.id] ?? 0) === pane);
}

/** Convenience for the many places that just want to open a thing. */
export function useOpen() {
  const { open } = useTabs();
  return {
    session: useCallback(
      (sessionId: string, beside?: boolean) =>
        open({ id: addressOf.session(sessionId), kind: "session", sessionId, face: "agent" }, beside),
      [open],
    ),
    file: useCallback(
      (sessionId: string, path: string, beside?: boolean) =>
        open({ id: addressOf.file(sessionId, path), kind: "file", sessionId, path }, beside),
      [open],
    ),
    diff: useCallback(
      (sessionId: string, path: string, beside?: boolean) =>
        open({ id: addressOf.diff(sessionId, path), kind: "diff", sessionId, path }, beside),
      [open],
    ),
  };
}
