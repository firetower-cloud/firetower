"use client";

/**
 * One socket for the page.
 *
 * A browser allows six connections per origin on HTTP/1.1, and the API is
 * plain HTTP, so there is no HTTP/2 here to multiplex for us. Every held-open
 * stream spent one of those six, and the conversation stream was one *per open
 * agent tab* — four tabs plus the event stream plus a poll in flight, and the
 * seventh request never ran. Starting a fifth agent failed because
 * `POST /sessions` could not get a connection; the new-tab menu said "no agents
 * configured" because `GET /agents` could not either. It looked like a limit on
 * agents.
 *
 * A WebSocket is not in that pool at all — Chrome allows a couple of hundred
 * per host, and terminals have always used one. So this costs nothing from the
 * six, and it does not grow with tabs, agents or workspaces: subscriptions are
 * cheap, connections are not.
 *
 * ## What it carries
 *
 * Things that change on their own. Anything you *ask* for — a file's contents,
 * a diff, the agent list — stays an ordinary request, which is what the six are
 * for now that they are free.
 *
 * ## Frames are validated, not cast
 *
 * `serverFrame` is generated from the Rust enum, so a field renamed there is a
 * build failure here. But generated types are a compile-time claim about bytes
 * that arrive at runtime, so every inbound frame is parsed through the
 * generated schema and a malformed one is dropped with a complaint rather than
 * cast into application state.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { StreamResponse } from "./generated/stream/stream.zod";
import type { ServerFrame } from "./generated/model";
import { wsBase, token } from "./http";
import { addressed, keyOf, nextResume, type Topic } from "./frames";

export type { Topic };

/** Told about frames for one subscription, and where it has got to. */
type Listener = {
  topic: Topic;
  id?: string;
  /** Read when resubscribing, so a reconnect resumes rather than replays. */
  cursor: () => number | undefined;
  onFrame: (frame: ServerFrame) => void;
};

type Socket = {
  /** Follow a topic until the returned function is called. */
  follow: (listener: Listener) => () => void;
  /** Whether the socket is up, for anything that wants to say so. */
  live: boolean;
};

const Ctx = createContext<Socket | null>(null);

/** Reconnect backoff: quick at first, then out of the way. */
const BACKOFF = [250, 500, 1_000, 2_000, 5_000, 10_000];

function send(ws: WebSocket | null, frame: object) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

function subscribe(ws: WebSocket | null, listener: Listener) {
  const from = listener.cursor();
  send(ws, {
    t: "sub",
    topic: listener.topic,
    ...(listener.id ? { id: listener.id } : {}),
    ...(from !== undefined ? { from } : {}),
  });
}

export function SocketProvider({ children }: { children: ReactNode }) {
  const [live, setLive] = useState(false);

  // Refs, not state: a tab opening must not re-render the tree, and the socket
  // callbacks read these from closures that outlive any one render.
  const listeners = useRef(new Set<Listener>());
  const socket = useRef<WebSocket | null>(null);
  // How recently each subscription was reset, so one that cannot be
  // re-established backs off instead of spinning.
  const resets = useRef(new Map<string, { at: number; run: number }>());

  const follow = useCallback((listener: Listener) => {
    const shared = [...listeners.current].some((l) => keyOf(l) === keyOf(listener));
    listeners.current.add(listener);

    // One subscription per topic-and-id however many components are watching.
    // Without this, two views of one conversation would send `unsub` when
    // either closed and silently blind the other.
    if (!shared) subscribe(socket.current, listener);

    return () => {
      listeners.current.delete(listener);
      const stillWanted = [...listeners.current].some((l) => keyOf(l) === keyOf(listener));
      if (stillWanted) return;
      send(socket.current, {
        t: "unsub",
        topic: listener.topic,
        ...(listener.id ? { id: listener.id } : {}),
      });
    };
  }, []);

  /**
   * Resubscribe after a reset, slowing down if they keep coming.
   *
   * A reset usually means "you fell behind, catch up", and immediately is the
   * right answer. But it also means "the thing feeding this went away", and if
   * it cannot be re-established the resubscribe ends the same way at once —
   * which without this is a tight loop between the two of us.
   */
  const resume = (ws: WebSocket, listener: Listener) => {
    const key = keyOf(listener);
    const now = Date.now();
    const { wait, run } = nextResume(resets.current.get(key), now);
    resets.current.set(key, { at: now, run });

    if (wait === 0) return subscribe(ws, listener);
    setTimeout(() => {
      if (socket.current === ws && listeners.current.has(listener)) subscribe(ws, listener);
    }, wait);
  };

  useEffect(() => {
    let closed = false;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let beat: ReturnType<typeof setInterval> | undefined;

    const open = () => {
      if (closed) return;

      const url = new URL(`${wsBase()}/api/v1/stream`);
      // The token rides in the query string, as the terminal socket's does: a
      // WebSocket handshake cannot carry headers. Moving both to a frame after
      // open is worth doing and is its own change.
      const auth = token();
      if (auth) url.searchParams.set("t", auth);

      const ws = new WebSocket(url);
      socket.current = ws;

      /** Whether this socket is still the one the page is using. */
      const current = () => socket.current === ws;

      ws.onopen = () => {
        // A socket that finished connecting after being superseded closes
        // rather than joining in. React mounts effects twice in development,
        // so this is the common case, not a corner.
        if (!current()) return void ws.close();

        attempt = 0;
        setLive(true);
        // Each subscription comes back with its own cursor — where it actually
        // got to, not where the server thinks it did. That is what makes a
        // reconnect leave no gap and replay nothing.
        const done = new Set<string>();
        for (const listener of listeners.current) {
          if (done.has(keyOf(listener))) continue;
          done.add(keyOf(listener));
          subscribe(ws, listener);
        }
        beat = setInterval(() => send(ws, { t: "ping" }), 30_000);
      };

      ws.onmessage = (message) => {
        if (!current()) return;
        const parsed = StreamResponse.safeParse(readable(message.data));
        if (!parsed.success) {
          console.error("[firetower] unusable frame", parsed.error);
          return;
        }
        const frame = parsed.data as ServerFrame;

        const resumed = new Set<string>();
        for (const listener of listeners.current) {
          if (!addressed(frame, listener)) continue;
          listener.onFrame(frame);
          // Behind, or its stream ended under it. Either way that one
          // subscription resumes from its own cursor; nothing else on the
          // socket is affected.
          if (frame.t === "reset" && !resumed.has(keyOf(listener))) {
            resumed.add(keyOf(listener));
            resume(ws, listener);
          }
        }
      };

      const gone = () => {
        if (beat) clearInterval(beat);
        // Only if this is still the live one. An earlier socket closing must
        // not clear the reference to its replacement — that left the page
        // holding a socket it had already thrown away: `follow` had nowhere to
        // send `sub`, so nothing was ever subscribed and no transcript arrived,
        // while the socket itself was open and healthy.
        //
        // React's development double-mount makes this happen on every load,
        // which is why every session came up with an empty conversation.
        if (!current()) return;
        socket.current = null;
        setLive(false);
        if (closed) return;
        retry = setTimeout(open, BACKOFF[Math.min(attempt++, BACKOFF.length - 1)]);
      };

      ws.onclose = gone;
      // `onerror` is always followed by `onclose`, so reconnecting is left to
      // that and this only says why — and only for the socket the page is
      // actually using. A superseded one erroring as it is closed mid-handshake
      // is the development double-mount, not a fault, and saying so on every
      // load trains people to ignore the line that matters.
      ws.onerror = () => {
        if (current()) console.warn("[firetower] stream socket error");
      };
    };

    open();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      if (beat) clearInterval(beat);
      const held = socket.current;
      socket.current = null;
      held?.close();
    };
    // Opened once for the life of the page. Everything that varies — who is
    // listening, where they got to — is read through refs.
  }, []);

  // Memoised on purpose. `follow` ends up in the dependencies of every
  // subscriber's effect, so a new object each render would tear down and
  // rebuild every subscription on any render of this provider.
  const value = useMemo<Socket>(() => ({ live, follow }), [live, follow]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSocket(): Socket {
  const held = useContext(Ctx);
  if (!held) throw new Error("useSocket outside the api provider");
  return held;
}

function readable(data: unknown): unknown {
  if (typeof data !== "string") return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}
