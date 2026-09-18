/**
 * The other end of the picker's bridge.
 *
 * The control plane injects a picker into any page served through a preview
 * hostname. The picker talks to a *panel* over `postMessage`; on the web the
 * panel is a page the picker embeds, here it is the window the preview sits
 * in. Same protocol, same origin checks, one listener per tab.
 *
 * Everything that arrives is from an untrusted page. Snapshots are validated
 * with the web's own schema before they reach state, and nothing is trusted
 * on the channel until the picker has answered a hello with `ready`.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { snapshotSchema, type ElementSnapshot } from "~/api/previewAnnotations";

/** A pick from the page. `point` is where the pointer was, in the frame's viewport. */
export type Selection = { snapshot: ElementSnapshot; parents: string[]; point?: [number, number] };

export type Pin = { id: string; path: string; selector: string; label: string; html: string };

type Handlers = {
  /** Where the page is now — pathname, search and hash. */
  onPath: (path: string) => void;
  onSelection: (s: Selection) => void;
  onLocated: (id: string, found: boolean) => void;
  onFocusNote: (id: string) => void;
};

/** What the panel may say to the picker. */
export type Outgoing =
  | { type: "mode"; enabled: boolean }
  | { type: "parent"; steps: number }
  | { type: "clear" }
  | { type: "pins"; pins: Pin[] }
  | { type: "locate"; id: string }
  | { type: "go"; delta: number }
  | { type: "reload" }
  | { type: "navigate"; path: string };

/** A point the page may claim the pointer was at: two real numbers, nothing else. */
const isPoint = (p: unknown): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number" && Number.isFinite(n));

/** A path the page may claim to be at: absolute, one line, not a URL in disguise. */
const isPath = (p: unknown): p is string => typeof p === "string" && p.startsWith("/") && !p.startsWith("//") && p.length <= 2048 && !/[\r\n]/.test(p);

export function usePickerBridge(
  frame: RefObject<HTMLIFrameElement | null>,
  origin: string | null,
  session: string,
  port: number,
  handlers: Handlers,
) {
  const [ready, setReady] = useState(false);
  const [annotating, setAnnotating] = useState(false);
  const readyRef = useRef(false);
  readyRef.current = ready;
  const channel = useRef<string | null>(null);
  const held = useRef(handlers);
  held.current = handlers;

  const tell = useCallback(
    (message: Outgoing) => {
      const target = frame.current?.contentWindow;
      if (!target || !origin || !channel.current) return;
      target.postMessage({ source: "firetower-panel", channel: channel.current, ...message }, origin);
    },
    [frame, origin],
  );

  useEffect(() => {
    if (!origin) return;
    const mine = crypto.randomUUID();
    channel.current = mine;
    setReady(false);

    const hello = () => frame.current?.contentWindow?.postMessage({ source: "firetower-panel", channel: mine, type: "hello" }, origin);

    const listen = (event: MessageEvent) => {
      const d = event.data as { source?: string; channel?: string; type?: string } & Record<string, unknown>;
      if (event.origin !== origin || event.source !== frame.current?.contentWindow || !d || d.source !== "firetower-picker") return;
      // `available` carries no channel: the page just loaded and wants a hello.
      if (d.type === "available") {
        hello();
        return;
      }
      if (d.channel !== mine) return;
      if (d.type === "ready" && d.session === session && d.port === port) {
        setReady(true);
        setAnnotating(d.enabled === true);
        if (isPath(d.path)) held.current.onPath(d.path);
      }
      if (d.type === "navigated" && isPath(d.path)) held.current.onPath(d.path);
      if (d.type === "mode") setAnnotating(d.enabled === true);
      if (d.type === "selection") {
        const parsed = snapshotSchema.safeParse(d.snapshot);
        const parents = d.parents;
        if (!parsed.success || !Array.isArray(parents) || parents.length > 10 || parents.some((p) => typeof p !== "string" || p.length > 500)) return;
        // A selection the page made without a pointer — a keypress, or the
        // panel's own step to the parent — carries no point, and the panel
        // falls back to what it can see of the element.
        held.current.onSelection({ snapshot: parsed.data, parents: parents as string[], point: isPoint(d.point) ? d.point : undefined });
      }
      if (d.type === "located" && typeof d.id === "string") held.current.onLocated(d.id, d.found === true);
      if (d.type === "focus-note" && typeof d.id === "string") held.current.onFocusNote(d.id);
    };

    window.addEventListener("message", listen);
    hello();
    // Until the picker answers, keep knocking: the page may still be loading.
    const knock = setInterval(() => {
      if (channel.current === mine && !readyRef.current) hello();
    }, 2000);
    return () => {
      clearInterval(knock);
      window.removeEventListener("message", listen);
      channel.current = null;
    };
  }, [origin, session, port, frame]);

  return { ready, annotating, tell };
}
