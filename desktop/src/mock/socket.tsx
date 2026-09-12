/**
 * The event stream, scripted.
 *
 * The product claim is *an agent needs you and you find out*, so a prototype in
 * which nothing ever moves cannot show the thing it exists to show. This replays
 * a timeline per backend: work progresses, an agent stops and asks, ember
 * arrives, and one server drops off the network while the others carry on.
 *
 * Same interface as `web/src/api/socket.tsx` — `SocketProvider` and `useSocket`
 * — so every component that follows a topic is unchanged.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { STATE, emit, setReach, watch, type BackendId } from "./backends";

export type Topic = "sessions" | "conversation";

type Listener = {
  topic: Topic;
  id?: string;
  cursor: () => number | undefined;
  onFrame: (frame: unknown) => void;
};

type Socket = { follow: (l: Listener) => () => void; live: boolean };

const Ctx = createContext<Socket | null>(null);

export function SocketProvider({ children }: { children: ReactNode }) {
  const [live] = useState(true);
  const socket = useMemo<Socket>(
    () => ({
      live,
      follow: () => () => {},
    }),
    [live],
  );
  return <Ctx.Provider value={socket}>{children}</Ctx.Provider>;
}

export function useSocket(): Socket {
  const held = useContext(Ctx);
  if (!held) throw new Error("useSocket outside the api provider");
  return held;
}

/** A beat in the demo. Seconds from when the window opened. */
type Beat = { at: number; do: () => void };

function bump(b: BackendId, n: number, status: string, note?: string) {
  const s = STATE[b].find((x) => x.number === n);
  if (!s) return;
  s.status = status as typeof s.status;
  s.note = note ?? null;
  s.updatedAt = new Date().toISOString();
  emit();
}

/**
 * Staggered on purpose. Three servers all lighting up at the same instant would
 * flatter the design; the real question is whether a merged inbox stays calm
 * when things arrive out of step, which is the only way they ever arrive.
 */
const TIMELINE: Beat[] = [
  { at: 9, do: () => bump("e2", 11, "NeedsYou", "The edge config has two limits for the same tenant. Keep the stricter one?") },
  { at: 17, do: () => bump("e1", 40, "Ready") },
  { at: 23, do: () => setReach("e2", "unreachable") },
  { at: 34, do: () => bump("me", 6, "NeedsYou", "Six tokens are unused. Delete them, or leave them and note it?") },
  { at: 46, do: () => setReach("e2", "live") },
  { at: 58, do: () => bump("e1", 40, "NeedsYou", "The scoped token needs a TTL. Fifteen minutes, or the session's lifetime?") },
];

let started = false;
export function runTimeline() {
  if (started) return;
  started = true;
  for (const beat of TIMELINE) setTimeout(beat.do, beat.at * 1000);
}

/** Re-render on any fixture change, wherever it came from. */
export function useFixtures() {
  const [, tick] = useState(0);
  useEffect(() => watch(() => tick((n) => n + 1)), []);
}
