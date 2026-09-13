/**
 * The event stream — real for a connected server, scripted for a fixture.
 *
 * `web/src/api/socket.tsx` is the whole protocol: one WebSocket per page,
 * `sessions` and `conversation` topics, per-subscription cursors, reconnect
 * with backoff. It reads its address and token from `./http`, which here is
 * the real-aware mutator — so for a live server it simply works, unchanged.
 *
 * Fixtures have no socket to open. They get a provider with the same shape
 * whose `follow` never delivers, and a scripted timeline that moves the
 * fixtures so the demo still shows an agent stopping and asking.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  SocketProvider as RealSocketProvider,
  useSocket as useRealSocket,
} from "../../../web/src/api/socket";
import type { Topic } from "../../../web/src/api/frames";
import { isLive } from "./http";
import { STATE, emit, setReach, watch, type BackendId } from "./backends";

export type { Topic };

type Listener = {
  topic: Topic;
  id?: string;
  cursor: () => number | undefined;
  onFrame: (frame: unknown) => void;
};
type Socket = { follow: (l: Listener) => () => void; live: boolean };

const Quiet = createContext<Socket | null>(null);

function QuietProvider({ children }: { children: ReactNode }) {
  const socket = useMemo<Socket>(() => ({ live: true, follow: () => () => {} }), []);
  return <Quiet.Provider value={socket}>{children}</Quiet.Provider>;
}

/** Real for a live backend, quiet for a fixture. Decided once, at mount. */
export function SocketProvider({ children }: { children: ReactNode }) {
  return isLive() ? <RealSocketProvider>{children}</RealSocketProvider> : <QuietProvider>{children}</QuietProvider>;
}

export function useSocket(): Socket {
  const quiet = useContext(Quiet);
  // Inside a real provider the quiet context is absent, and vice versa.
  if (quiet) return quiet;
  return useRealSocket() as Socket;
}

/* ── The scripted demo ─────────────────────────────────────────────────── */

type Beat = { at: number; do: () => void };

function bump(b: BackendId, ws: string, status: string, note?: string) {
  const s = STATE[b].find((x) => x.workspaceId === ws);
  if (!s) return;
  s.status = status as typeof s.status;
  s.note = note ?? null;
  s.updatedAt = new Date().toISOString();
  emit();
}

const TIMELINE: Beat[] = [
  { at: 12, do: () => bump("e2", "w_e2_limits", "NeedsYou", "The edge config has two limits for the same tenant. Keep the stricter one?") },
  { at: 22, do: () => bump("e1", "w_e1_pricing", "Ready") },
  { at: 30, do: () => setReach("e2", "unreachable") },
  { at: 44, do: () => bump("me", "w_me_tokens", "NeedsYou", "Six tokens are unused. Delete them, or leave them and note it?") },
  { at: 58, do: () => setReach("e2", "live") },
  { at: 72, do: () => bump("e1", "w_e1_tokens", "NeedsYou", "The scoped token needs a TTL. Fifteen minutes, or the session's lifetime?") },
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
