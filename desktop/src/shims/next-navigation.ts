/**
 * A hash router, standing in for the app router.
 *
 * The desktop app loads from a file, so there is no server to own a path and
 * `history.pushState` has nowhere meaningful to push. The hash is the whole
 * address, which is also what makes deep links (`firetower://…`) land somewhere
 * without a route table.
 */
import { useCallback, useEffect, useRef, useState } from "react";

const listeners = new Set<() => void>();

/**
 * The shell owns history.
 *
 * `Workspace.tsx` keeps the address bar in step with the open workspace by
 * calling `history.replaceState(null, "", "/sessions/<id>")`. That is right for
 * a page served by a control plane and wrong for a window loaded from a file:
 * there is no path to write, and writing one strands the router — the app goes
 * blank and a reload 404s.
 *
 * Rather than fork the component for it, bare-path writes are folded into the
 * hash here. The component stays honest about its intent and the shell decides
 * what an address means, which is the right division for any desktop build.
 */
function ownHistory() {
  for (const name of ["pushState", "replaceState"] as const) {
    const original = window.history[name].bind(window.history);
    window.history[name] = (data: unknown, unused: string, url?: string | URL | null) => {
      if (typeof url === "string" && url.startsWith("/")) {
        original(data, unused, `#${url}`);
        listeners.forEach((l) => l());
        return;
      }
      original(data, unused, url as string);
    };
  }
}

if (typeof window !== "undefined") ownHistory();

/**
 * Where we are, and `"/"` when there is no window to ask.
 *
 * The guard is not defensive padding: half the component tests render to a
 * static string under node, with no DOM at all, and the first screen that
 * read the path inside its own body took eight of them down with a
 * `ReferenceError`. A router that cannot be rendered without a browser is a
 * router that cannot be tested.
 */
function currentPath(): string {
  if (typeof window === "undefined") return "/";
  const h = window.location.hash.replace(/^#/, "");
  return h || "/";
}

/**
 * A screen that would lose work if the address changed, and what to ask.
 *
 * **Only while it would lose something**, and the screen decides that per
 * call. A guard that outlives its screen breaks navigation everywhere, so
 * `useLeaveGuard` drops it on unmount.
 *
 * **More than one can be registered, and they are asked in turn**, because
 * more than one can be on screen: a team's map holds a draft of the tree, and
 * the profile drawer docked beside it holds a draft of a profile. Two commit
 * boundaries, two questions, and each sheet speaks only for its own draft —
 * so none of them can understate what leaving costs.
 *
 * **The most recently mounted is asked first.** The drawer opens beside the
 * map rather than the other way round, so it is the thing somebody was last
 * working in, and it is the one whose sheet should come up first. It also
 * matters for a harder reason: the map's Discard closes the drawer, and with
 * the map asked first a person could press Discard on a sentence counting
 * only the map's changes and lose the drawer's edit with no second question.
 * The sentence was right about what it counted and wrong about what went,
 * which is worse than the silent loss this exists to prevent.
 *
 * **An answered guard is skipped for the rest of one navigation, not
 * dropped.** It was deleted, so cancelling at the second sheet left the first
 * screen unguarded for the rest of its life.
 *
 * Consulted by `navigate` and not by `hashchange`: a rail row, a palette
 * command and a back link all go through `navigate`, and the ones that do
 * not — a deep link from outside the window, a reload — are not somebody
 * choosing to leave a form.
 */
type Guard = (resume: () => void) => boolean;
const guards = new Set<Guard>();

/**
 * Ask whoever is holding unsaved work, and chain.
 *
 * `true` means a guard has taken it: it has put a question on screen and will
 * call its `resume` if the answer is to go. That resume asks the *rest* of
 * them, and only runs `proceed` once nobody is left with something to say.
 */
function askBeforeLeaving(proceed: () => void, asked: Set<Guard>): boolean {
  for (const guard of [...guards].reverse()) {
    if (asked.has(guard)) continue;
    const taken = guard(() => {
      const next = new Set(asked).add(guard);
      if (!askBeforeLeaving(proceed, next)) proceed();
    });
    if (taken) return true;
  }
  return false;
}

function go(to: string, replace = false) {
  const commit = () => {
    const next = `#${to.startsWith("/") ? to : `/${to}`}`;
    if (replace) window.history.replaceState(null, "", next);
    else window.location.hash = next;
    listeners.forEach((l) => l());
  };
  if (askBeforeLeaving(commit, new Set())) return;
  commit();
}

export function navigate(to: string) {
  go(to);
}

/**
 * Ask before this screen is left.
 *
 * `ask` answers `true` when it has taken the navigation, and `false` to let
 * it through — which is what a screen with nothing unsaved answers. It stays
 * registered for as long as the component is mounted; the decision is `ask`'s,
 * every time.
 */
export function useLeaveGuard(ask: (resume: () => void) => boolean) {
  const latest = useRef(ask);
  latest.current = ask;
  useEffect(() => {
    const guard: Guard = (resume) => latest.current(resume);
    guards.add(guard);
    return () => {
      guards.delete(guard);
    };
  }, []);
}

/**
 * For tests: what is registered, asking exactly as `navigate` asks, and
 * clearing it.
 *
 * `ask` is the real path rather than a simplified one, because the order the
 * guards are asked in and the chain between them are the whole of what there
 * is to get wrong.
 */
export const leaveGuard = {
  ask: (resume: () => void) => askBeforeLeaving(resume, new Set()),
  /** Register one, the way a mounted component does. Order is mount order. */
  add: (ask: Guard) => guards.add(ask),
  armed: () => guards.size > 0,
  clear: () => guards.clear(),
};

export function usePathname(): string {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const onChange = () => setPath(currentPath());
    listeners.add(onChange);
    window.addEventListener("hashchange", onChange);
    return () => {
      listeners.delete(onChange);
      window.removeEventListener("hashchange", onChange);
    };
  }, []);
  return path;
}

export function useRouter() {
  return {
    push: useCallback((to: string) => go(to), []),
    replace: useCallback((to: string) => go(to, true), []),
    back: useCallback(() => window.history.back(), []),
    forward: useCallback(() => window.history.forward(), []),
    refresh: useCallback(() => listeners.forEach((l) => l()), []),
    prefetch: useCallback(() => {}, []),
  };
}

export function useSearchParams(): URLSearchParams {
  const path = usePathname();
  const q = path.indexOf("?");
  return new URLSearchParams(q === -1 ? "" : path.slice(q));
}

export function useParams(): Record<string, string> {
  return {};
}
