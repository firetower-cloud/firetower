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
 * A shell in the session's workspace.
 *
 * Yours, not the agent's. Keystrokes go through untouched — arrow keys, tab
 * completion, `Ctrl-C` — because this is a real terminal for going and looking
 * at what the agent has been doing to a checkout.
 *
 * The agent used to have one of these too, and you drove it by typing at it.
 * It speaks a protocol now, so what it is doing is read as a conversation and
 * answered with messages, and this is the only terminal left.
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
      url.searchParams.set("shell", "true");
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
    // Edge to edge. A terminal is the whole pane: the tab above already says
    // what it is, so a title bar repeated the label, and a border drew a box
    // around something that has no reason not to reach the sides.
    <div className="relative h-full overflow-hidden bg-[#0f0e0d]">
      {/* Four pixels, so glyphs and the cursor do not sit against the edge.
          It goes on the host rather than the box around it because the fit
          addon measures this element's content box to work out how many
          columns fit — padding here is subtracted, padding outside it is not. */}
      <div ref={host} className="h-full w-full p-[4px]" />

      {/* The one state worth interrupting for. Nothing is drawn while it is
          connected, which is almost always — a permanent bar saying "Shell"
          spent a row on a fact that never changes. */}
      {state === "closed" && (
        <div className="absolute top-2 right-3 flex items-center gap-2 rounded-[7px] border border-line bg-panel px-2.5 py-1.5">
          <span className="h-1.5 w-1.5 rounded-full border border-mute" />
          <span className="text-[11.5px] text-mute">Detached</span>
          <button
            onClick={() => setAttempt((n) => n + 1)}
            className="text-[11.5px] text-dim transition-colors hover:text-ember"
          >
            Reconnect
          </button>
        </div>
      )}
    </div>
  );
}
