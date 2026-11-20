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
 * **More than one can be registered**, because more than one can be on
 * screen: a team's map holds a draft of the tree, and the profile drawer
 * docked beside it holds a draft of a profile. They are two commit
 * boundaries and two questions, so each asks its own and the second is asked
 * once the first has been answered. It was a single slot, and a second
 * screen registering one silently took the first's place — the shape that
 * drops exactly the work this exists to protect.
 *
 * Consulted by `navigate` and not by `hashchange`: a rail row, a palette
 * command and a back link all go through `navigate`, and the ones that do
 * not — a deep link from outside the window, a reload — are not somebody
 * choosing to leave a form.
 */
type Guard = (resume: () => void) => boolean;
const guards = new Set<Guard>();

function go(to: string, replace = false) {
  /* `true` means a guard has taken it: it has put a question on screen and
     will call `resume` if the answer is to go. `resume` drops that guard and
     tries again, so a second one still gets its turn and the one already
     answered does not ask twice. */
  for (const guard of [...guards]) {
    const taken = guard(() => {
      guards.delete(guard);
      go(to, replace);
    });
    if (taken) return;
  }
  const next = `#${to.startsWith("/") ? to : `/${to}`}`;
  if (replace) window.history.replaceState(null, "", next);
  else window.location.hash = next;
  listeners.forEach((l) => l());
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

/** For tests: what is registered, and clearing it. */
export const leaveGuard = {
  ask: (resume: () => void) => [...guards].some((g) => g(resume)),
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
