/**
 * One way to start a workspace, wherever the request came from.
 *
 * The rail's `+`, a task's Start, and Cmd-N all mean the same thing and differ
 * only in how much they already know. Routing them through one place is what
 * keeps a task's Start one click rather than a second form that happens to
 * look similar.
 *
 * It used to open a sheet; it now goes to the New page (`/new`). What little a
 * caller already knows — a task's title and repository — rides in a module
 * variable the page reads once, because a hash route carries no state of its
 * own and a task's Start should stay one click.
 */
import type { ReactNode } from "react";
import { navigate } from "~/shims/next-navigation";
import type { Seed } from "~/ui/NewWorkspace";

export type { Seed };

let pending: Seed | undefined;

/**
 * Whatever a `start(seed)` left, **without taking it**.
 *
 * This was `consumeSeed()`: read once in a `useMemo` on mount, and it cleared
 * the module variable as it read. Driven and counted, that runs **twice for
 * one press** — `["a seed", "nothing"]` — because React double-invokes a
 * `useMemo` factory under `StrictMode`, and it works today only because React
 * keeps the result of the *first* invocation. Nothing in the code said so and
 * nothing would have failed if that had changed.
 *
 * A real remount between the navigation and the first paint — a key change on
 * the provider, a suspense boundary resolving — has the same shape and a worse
 * ending: the seed goes to the instance that is thrown away and the one that
 * survives gets nothing. **The symptom is an empty composer on a plain home**,
 * which is indistinguishable from *Start did nothing*, and that is the bug the
 * whole exploration exists for.
 *
 * So reading is idempotent and the clearing is a separate act, done when the
 * composer that read it goes away.
 */
export function seedWaiting(): Seed | undefined {
  return pending;
}

/**
 * Drop a seed, **if it is still the one that was read**.
 *
 * The identity check is the whole of it. Without it, this is ordering-
 * dependent: on a route key change React renders the new subtree before it
 * runs the old one's cleanups, so an unconditional clear would happen to work
 * and would break the day that ordering changed. With it, a `start(other)`
 * that lands while the old composer is still unmounting keeps its seed.
 */
export function dropSeed(which: Seed) {
  if (pending === which) pending = undefined;
}

/** Start a workspace: carry any seed, then go to the New page. */
export function useStart() {
  return (seed?: Seed) => {
    pending = seed;
    navigate("/new");
  };
}

/**
 * Kept so the tree that wrapped the old sheet needs no restructuring; it now
 * renders only its children, since the New page is a route rather than a layer.
 */
export function StartProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
