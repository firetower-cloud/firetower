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

/** Read and clear whatever a `start(seed)` left for the New page. */
export function consumeSeed(): Seed | undefined {
  const seed = pending;
  pending = undefined;
  return seed;
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
