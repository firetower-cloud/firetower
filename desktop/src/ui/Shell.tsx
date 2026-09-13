/**
 * A shell in the session's workspace.
 *
 * Yours, not the agent's: keystrokes go through untouched, so `Ctrl-C`, `Tab`
 * and arrows do what a terminal does with them. The protocol is the web's —
 * a WebSocket to `sessions/{id}/pty`, bytes both ways, a text frame to
 * resize — and so is the reconnect while a session is still starting.
 *
 * What is added is what an editor's terminal has: paths in the output open
 * the file (checked against the workspace first), `⌘F` searches the
 * scrollback, `⌘K` clears, and `⌘C`/`⌘V` are copy and paste rather than
 * anything the pty would see.
 *
 * It stays mounted behind a hidden panel. The worker ends the shell when its
 * viewer detaches, so hiding must never detach — only closing does.
 */
import { useEffect, useRef, useState } from "react";
import type { Terminal as Xterm } from "@xterm/xterm";
import type { SearchAddon as Search } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { Search as SearchIcon, X } from "lucide-react";
import { token, wsBase } from "~/mock/http";
import { findPaths, resolvePath } from "~/paths";

type State = "connecting" | "live" | "closed";

export function Shell({
  sessionId,
  ended,
  showing,
  onOpenPath,
}: {
  sessionId: string;
  ended: boolean;
  showing: boolean;
  onOpenPath: (path: string, line?: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<Xterm | null>(null);
  const searcher = useRef<Search | null>(null);
  const open = useRef(onOpenPath);
  open.current = onOpenPath;
  const [state, setState] = useState<State>("connecting");
  const [attempt, setAttempt] = useState(0);
  const [finding, setFinding] = useState<string | null>(null);

  // A session still starting refuses the first attach; trying again is this
  // component's job, not the person's.
  useEffect(() => {
    if (state !== "closed" || ended) return;
    const again = setTimeout(() => setAttempt((n) => n + 1), 1_500);
    return () => clearTimeout(again);
  }, [state, ended]);

  useEffect(() => {
    if (!host.current || ended) return;
    setState("connecting");
    let disposed = false;
    let socket: WebSocket | null = null;
    let cleanup = () => {};

    (async () => {
      const [{ Terminal: Xterm }, { FitAddon }, { SearchAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/addon-search")]);
      if (disposed || !host.current) return;

      const mono = paint("--font-jetbrains");
      const term = new Xterm({
        fontFamily: `${mono || "ui-monospace"}, ui-monospace, SFMono-Regular, Menlo, monospace`,
        fontSize: 13,
        lineHeight: 1.35,
        cursorBlink: true,
        macOptionIsMeta: true,
        theme: {
          background: paint("--color-ground"),
          foreground: paint("--color-text"),
          cursor: paint("--color-ember"),
          selectionBackground: paint("--color-overlay"),
        },
        scrollback: 10000,
      });
      const fit = new FitAddon();
      const search = new SearchAddon();
      term.loadAddon(fit);
      term.loadAddon(search);
      term.open(host.current);
      fit.fit();
      instance.current = term;
      searcher.current = search;

      /* ⌘ is the app's, not the pty's. Copy and paste are left to the browser
         (xterm turns a paste event into input); the rest are handled here and
         swallowed so the workbench never sees them either. */
      term.attachCustomKeyEventHandler((e) => {
        if (!e.metaKey || e.type !== "keydown") return true;
        const k = e.key.toLowerCase();
        // Copy and paste: the browser's, and nobody else's business.
        if (k === "c" || k === "v") return false;
        // Ours — and stopped here, so the palette's ⌘K and the rest of the
        // app's shortcuts never hear them. ⌘J goes on up: it is the panel's.
        if (k === "k" || k === "f") {
          e.preventDefault();
          e.stopPropagation();
          if (k === "k") term.clear();
          else setFinding("");
          return false;
        }
        if (k !== "j") e.stopPropagation();
        return false;
      });

      /* Paths in the output open the file — after the workspace has said the
         path is real, so nothing is underlined that would open nothing. */
      const links = {
        provideLinks(y: number, callback: (links: { range: { start: { x: number; y: number }; end: { x: number; y: number } }; text: string; activate: () => void }[] | undefined) => void) {
          const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
          const found = findPaths(text);
          if (found.length === 0) return callback(undefined);
          Promise.all(found.map((f) => resolvePath(sessionId, f.path))).then((real) => {
            callback(
              found.flatMap((f, i) =>
                real[i]
                  ? [{ range: { start: { x: f.start + 1, y }, end: { x: f.end, y } }, text: f.text, activate: () => open.current(real[i]!, f.line) }]
                  : [],
              ),
            );
          });
        },
      };
      term.registerLinkProvider(links);
      if (import.meta.env.DEV) Object.assign(window, { __ftTerm: term, __ftLinks: links });

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
          term.writeln(`\r\n\x1b[31m${event.data}\x1b[0m`);
          return;
        }
        term.write(new Uint8Array(event.data));
      };
      const typed = term.onData((data) => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(new TextEncoder().encode(data));
      });
      const resize = () => {
        if (!host.current || host.current.clientHeight === 0) return;
        fit.fit();
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: "Resize", cols: term.cols, rows: term.rows }));
      };
      const observer = new ResizeObserver(resize);
      observer.observe(host.current);

      cleanup = () => {
        observer.disconnect();
        typed.dispose();
        socket?.close();
        term.dispose();
        instance.current = null;
        searcher.current = null;
      };
    })();

    return () => {
      disposed = true;
      cleanup();
    };
  }, [sessionId, attempt, ended]);

  // Focus follows the panel: a focused terminal you cannot see would take
  // your keystrokes.
  useEffect(() => {
    if (showing && state === "live" && finding === null) instance.current?.focus();
    else if (!showing) instance.current?.blur();
  }, [showing, state, finding]);

  return (
    <div className="relative h-full overflow-hidden bg-ground">
      {/* Padding on the host itself: the fit addon measures this element's content box. */}
      <div ref={host} className="h-full w-full p-[6px]" />

      {ended && (
        <div className="absolute inset-0 grid place-items-center bg-ground">
          <p className="text-meta text-mute">This session has ended. There is no shell to open.</p>
        </div>
      )}

      {!ended && state === "closed" && (
        <div className="absolute top-2 right-3 flex items-center gap-2 rounded-md border border-line bg-panel px-2.5 py-1.5">
          <span className="h-1.5 w-1.5 rounded-full border border-mute" />
          <span className="text-meta text-mute">Detached</span>
          <button onClick={() => setAttempt((n) => n + 1)} className="text-meta text-dim transition-colors hover:text-bone">Reconnect</button>
        </div>
      )}

      {finding !== null && (
        <div className="absolute top-2 right-3 flex items-center gap-1.5 rounded-md border border-line bg-panel py-1 pr-1 pl-2.5 shadow-(--shadow-float)">
          <SearchIcon className="h-3.5 w-3.5 text-mute" strokeWidth={1.75} />
          <input
            autoFocus
            value={finding}
            onChange={(e) => {
              setFinding(e.target.value);
              searcher.current?.findNext(e.target.value, { incremental: true });
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setFinding(null);
              if (e.key === "Enter") (e.shiftKey ? searcher.current?.findPrevious(finding) : searcher.current?.findNext(finding));
            }}
            placeholder="Find in scrollback"
            className="w-48 bg-transparent font-mono text-meta text-bone placeholder:text-mute focus:outline-none"
          />
          <button onClick={() => setFinding(null)} className="grid h-6 w-6 place-items-center rounded text-mute hover:bg-raise hover:text-bone"><X className="h-3.5 w-3.5" strokeWidth={2} /></button>
        </div>
      )}
    </div>
  );
}

/** A colour or a font from the design tokens, for the one consumer that paints into a canvas. */
function paint(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
