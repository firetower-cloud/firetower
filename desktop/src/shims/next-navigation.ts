/**
 * A hash router, standing in for the app router.
 *
 * The desktop app loads from a file, so there is no server to own a path and
 * `history.pushState` has nowhere meaningful to push. The hash is the whole
 * address, which is also what makes deep links (`firetower://…`) land somewhere
 * without a route table.
 */
import { useCallback, useEffect, useState } from "react";

const listeners = new Set<() => void>();

function currentPath(): string {
  const h = window.location.hash.replace(/^#/, "");
  return h || "/";
}

function go(to: string, replace = false) {
  const next = `#${to.startsWith("/") ? to : `/${to}`}`;
  if (replace) window.history.replaceState(null, "", next);
  else window.location.hash = next;
  listeners.forEach((l) => l());
}

export function navigate(to: string) {
  go(to);
}

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
