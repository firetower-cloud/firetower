/**
 * Enough of React's hooks for a node test runner.
 *
 * `vitest.config.ts` says it plainly — the logic, without a renderer — and
 * everything tested here until now was a pure function over the contract.
 * This project has no renderer to borrow: no `react-test-renderer`, no DOM,
 * and `Peek.tsx` reaches reanimated and gesture-handler, neither of which
 * parses in node.
 *
 * One defect made that a problem rather than a preference. `usePending` keeps
 * its state in a **hook slot**, and a slot outlives the session that was in
 * it: when the blocked set changes, the slot renders once with the previous
 * session's answer in it before its effect has run. That is not a fact about
 * a pure function — it is a fact about **the gap between a commit and its
 * effects**, which is the one thing a pure test cannot see.
 *
 * So the gap is the thing this models, and it is the whole reason the two
 * calls are separate:
 *
 * - `render()` commits a frame. Nothing else. This is what a reader sees.
 * - `flush()` runs the effects React would run after that commit.
 *
 * A `setState` landing from outside a render — a resolved fetch — re-renders
 * and flushes, the way React does. Deps are compared with `Object.is` per
 * element, an absent array always re-runs, and a changed dep tears the
 * previous effect down before the next runs.
 *
 * It is not React and it is not trying to be. It is the ordering, which is
 * where the bug was.
 */

type Deps = readonly unknown[] | undefined;

type Cell =
  | { kind: "state"; value: unknown }
  | { kind: "memo"; deps: Deps; value: unknown }
  | { kind: "effect"; deps: Deps; seen: boolean; run?: Effect; stop?: () => void };

type Effect = () => void | (() => void);

let cells: Cell[] = [];
let at = 0;
let queue: Extract<Cell, { kind: "effect" }>[] = [];
let body: (() => unknown) | null = null;
let drawn: unknown = undefined;
let drawing = false;

function same(a: Deps, b: Deps): boolean {
  if (!a || !b) return false;
  return a.length === b.length && a.every((dep, i) => Object.is(dep, b[i]));
}

function cell<T extends Cell>(make: () => T): T {
  const held = cells[at];
  if (held) {
    at += 1;
    return held as T;
  }
  const made = make();
  cells[at] = made;
  at += 1;
  return made;
}

export function useState<T>(initial: T | (() => T)) {
  const held = cell<Extract<Cell, { kind: "state" }>>(() => ({
    kind: "state",
    value: typeof initial === "function" ? (initial as () => T)() : initial,
  }));
  const set = (next: T | ((was: T) => T)) => {
    held.value = typeof next === "function" ? (next as (was: T) => T)(held.value as T) : next;
    /* React re-renders and then runs whatever that render queued. A read
       landing from a promise takes this path, which is why it is here and not
       in the test. */
    if (!drawing) {
      render();
      flush();
    }
  };
  return [held.value as T, set] as const;
}

export function useMemo<T>(make: () => T, deps: Deps): T {
  const held = cell<Extract<Cell, { kind: "memo" }>>(() => ({ kind: "memo", deps, value: make() }));
  if (!same(held.deps, deps)) {
    held.deps = deps;
    held.value = make();
  }
  return held.value as T;
}

export function useCallback<T>(fn: T, deps: Deps): T {
  return useMemo(() => fn, deps);
}

export function useEffect(run: Effect, deps?: Deps) {
  const held = cell<Extract<Cell, { kind: "effect" }>>(() => ({ kind: "effect", deps, seen: false }));
  if (!held.seen || !same(held.deps, deps)) {
    held.seen = true;
    held.deps = deps;
    held.run = run;
    queue.push(held);
  }
}

export function useRef<T>(initial: T) {
  return useMemo(() => ({ current: initial }), []);
}

/**
 * What a `vi.mock("react", …)` factory hands back.
 *
 * `createContext` is not part of the model and never will be — it is here
 * because `api/conversation.ts` imports the socket provider, which makes one
 * at module scope. Mocking a module replaces all of it, so an import three
 * files away that nothing under test calls still has to resolve. The same
 * bargain `test/react-native.stub.ts` already took.
 */
export const react = {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
  createContext: () => ({ Provider: null, Consumer: null }),
  useContext: () => null,
};

/** Mount a hook. One frame, and its effects. */
export function mount<T>(hook: () => T): T {
  cells = [];
  at = 0;
  queue = [];
  body = hook as () => unknown;
  render();
  flush();
  return drawn as T;
}

/**
 * Commit one frame, **without** running its effects.
 *
 * This is the state a reader's thumb lands in. Call `flush()` to let React
 * catch up.
 */
export function render<T>(): T {
  at = 0;
  drawing = true;
  try {
    drawn = body!();
  } finally {
    drawing = false;
  }
  return drawn as T;
}

/** Run what the last render queued, tearing down what it replaces. */
export function flush() {
  const due = queue;
  queue = [];
  for (const effect of due) {
    effect.stop?.();
    effect.stop = effect.run?.() ?? undefined;
  }
}

/** The last frame committed. */
export function last<T>(): T {
  return drawn as T;
}

/** Unmount: every effect torn down, every slot forgotten. */
export function unmount() {
  for (const held of cells) {
    if (held.kind === "effect") held.stop?.();
  }
  cells = [];
  queue = [];
  body = null;
}
