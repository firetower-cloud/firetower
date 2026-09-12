/**
 * One way to start a workspace, wherever the request came from.
 *
 * The rail's `+`, a task's Start, and Cmd-N all mean the same thing and differ
 * only in how much they already know. Routing them through one place is what
 * keeps a task's Start one click rather than a second form that happens to
 * look similar.
 */
import { createContext, useContext, useState, type ReactNode } from "react";
import type { Seed } from "~/ui/NewWorkspace";

const Ctx = createContext<((seed?: Seed) => void) | null>(null);

export function StartProvider({
  children,
  render,
}: {
  children: ReactNode;
  render: (seed: Seed | undefined, close: () => void) => ReactNode;
}) {
  const [asking, setAsking] = useState<{ seed?: Seed } | null>(null);
  return (
    <Ctx.Provider value={(seed) => setAsking({ seed })}>
      {children}
      {asking && render(asking.seed, () => setAsking(null))}
    </Ctx.Provider>
  );
}

export function useStart() {
  const start = useContext(Ctx);
  if (!start) throw new Error("useStart outside StartProvider");
  return start;
}
