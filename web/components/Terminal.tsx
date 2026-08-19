"use client";

import { useEffect, useRef, useState } from "react";
// Type only, so the import disappears at build time: the library itself is
// loaded below, inside the effect, for the reason given there.
import type { Terminal as Xterm } from "@xterm/xterm";
import { wsBase, token } from "@/src/api/http";
// xterm positions rows and measures cells from its own stylesheet. Without it
// every glyph lands at the wrong width and the screen looks stretched.
import "@xterm/xterm/css/xterm.css";

type State = "connecting" | "live" | "closed";

/**
 * The agent's terminal, as it is.
 *
 * Not a transcript and not a message box: keystrokes go through untouched, so
 * arrow keys, tab completion and `Ctrl-C` all reach the agent. That's the point
 * — you're driving the CLI, not talking to a wrapper around it.
 */
export function Terminal({
  sessionId,
  live,
  /**
   * Whether the terminal is the panel on screen.
   *
   * It stays mounted behind the other tab rather than being torn down and
   * reattached, so this is what tells it apart from being visible.
   */
  showing = true,
}: {
  sessionId: string;
  live: boolean;
  showing?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  /** The attached terminal, for the focus effect below. */
  const instance = useRef<Xterm | null>(null);
  const [state, setState] = useState<State>("connecting");
  /** Bumping this re-runs the effect below, which is one whole new attachment. */
  const [attempt, setAttempt] = useState(0);

  // A session that is still starting has no agent to attach to yet, so the
  // first attempt is refused — correctly. Waiting for the agent and trying
  // again is this component's job; it used to be the person's, by reloading
  // the page, which is not a thing anyone should have to work out.
  useEffect(() => {
    if (state !== "closed" || !live) return;
    const again = setTimeout(() => setAttempt((n) => n + 1), 1_500);
    return () => clearTimeout(again);
  }, [state, live]);

  useEffect(() => {
    if (!host.current) return;
    setState("connecting");

    let disposed = false;
    let socket: WebSocket | null = null;
    let cleanup = () => {};

    // Loaded here rather than imported at the top: xterm reaches for `window`
    // as it initialises, which a server render doesn't have.
    (async () => {
      const { Terminal: Xterm } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      if (disposed || !host.current) return;

      // Resolved to the real family name rather than passed as `var(...)`:
      // the font is self-hosted under a generated name, and xterm measures a
      // character literally to work out its cell size.
      const mono = getComputedStyle(document.documentElement)
        .getPropertyValue("--font-jetbrains")
        .trim();

      const term = new Xterm({
        fontFamily: `${mono || "ui-monospace"}, ui-monospace, SFMono-Regular, Menlo, monospace`,
        fontSize: 12.5,
        lineHeight: 1.35,
        cursorBlink: true,
        // Matches the panel it sits in, so the terminal reads as part of the
        // page rather than a black rectangle dropped onto it.
        theme: {
          background: "#0f0e0d",
          foreground: "#d8d2c8",
          cursor: "#f26430",
          selectionBackground: "#2a2724",
        },
        scrollback: 10000,
      });

      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host.current);
      fit.fit();
      instance.current = term;

      const url = new URL(`${wsBase()}/api/v1/sessions/${sessionId}/pty`);
      url.searchParams.set("cols", String(term.cols));
      url.searchParams.set("rows", String(term.rows));
      const auth = token();
      if (auth) url.searchParams.set("t", auth);

      socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";

      socket.onopen = () => setState("live");
      socket.onclose = () => setState("closed");
      socket.onerror = () => setState("closed");

      socket.onmessage = (event) => {
        if (typeof event.data === "string") {
          // Control messages are rare and always an explanation of a refusal.
          term.writeln(`\r\n\x1b[31m${event.data}\x1b[0m`);
          return;
        }
        term.write(new Uint8Array(event.data));
      };

      // Bytes, not text: this is how a control character stays one.
      const typed = term.onData((data) => {
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(new TextEncoder().encode(data));
        }
      });

      const resize = () => {
        fit.fit();
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ t: "Resize", cols: term.cols, rows: term.rows }));
        }
      };

      const observer = new ResizeObserver(resize);
      observer.observe(host.current);

      cleanup = () => {
        observer.disconnect();
        typed.dispose();
        socket?.close();
        term.dispose();
        instance.current = null;
      };
    })();

    return () => {
      disposed = true;
      cleanup();
    };
  }, [sessionId, attempt]);

  // Opening a session and being unable to type into it was a click that never
  // did anything else. Focus follows the tab rather than the mount: the
  // terminal stays attached behind the other one, and a focused terminal you
  // cannot see would take your keystrokes and send them to the agent.
  useEffect(() => {
    if (showing && state === "live") instance.current?.focus();
    else instance.current?.blur();
  }, [showing, state]);

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-[6px] border border-line bg-[#0f0e0d]">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            state === "live"
              ? "bg-sage"
              : state === "connecting"
                ? "bg-mute"
                : "border border-mute"
          }`}
        />
        <span className="font-narrow text-[9.5px] font-semibold tracking-[0.14em] text-mute uppercase">
          {state === "live" ? "Terminal" : state === "connecting" ? "Connecting" : "Detached"}
        </span>
        {state === "closed" && (
          <button
            onClick={() => setAttempt((n) => n + 1)}
            className="ml-auto text-[11px] text-mute transition-colors hover:text-ember"
          >
            Reconnect
          </button>
        )}
      </div>

      <div ref={host} className="min-h-0 flex-1 px-2 py-1" />
    </div>
  );
}
