/**
 * An artifact, in a tab of its own.
 *
 * Deliberately *not* `PreviewTab`. A preview is an application you navigate —
 * back, forward, an address bar, three viewport widths — because the thing
 * you are looking at has pages. An artifact is one document, and all of that
 * chrome is width taken away from the only thing on screen.
 *
 * So: the title, the version, and Expand. The notes list lives behind a count
 * rather than a permanent rail, because the rail is what made the preview feel
 * cramped and a document is mostly reading.
 *
 * **Expand is the point.** The complaint this whole feature answers is that
 * reading comfortably meant opening a browser tab, and the picker the control
 * plane injects refuses to run when `window.parent === window` — so the
 * browser is exactly where annotating stops working. Expanding inside the app
 * keeps the frame a frame, so Annotate goes on working at full width.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ExternalLink, Maximize2, Minimize2, Send, Trash2 } from "lucide-react";
import type { Artifact } from "~/api/generated/model";
import { sendTurn } from "~/api/generated/sessions/sessions";
import { openExternal } from "~/open";
import { why } from "~/data";
import { Annotate, type Anchor } from "~/ui/Annotate";
import { anchorIn } from "~/preview/anchor";
import { usePickerBridge, type Selection } from "~/preview/bridge";

/** What an element is, for a person: its tag and a little of its text. */
function nameOf(label: string, html: string): string {
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text ? `<${label}> ${text.length > 40 ? `${text.slice(0, 40)}…` : text}` : `<${label}>`;
}

/** Where this app is, as an origin the picker will accept. */
const self = () =>
  location.origin && location.origin !== "null" ? location.origin : `${location.protocol}//${location.host}`;

type Note = { id: string; what: string; html: string; text: string; sent: boolean };

export function ArtifactTab({
  artifact,
  sessionId,
  expanded,
  onExpanded,
}: {
  artifact: Artifact;
  /** Where to send notes. Absent when the session that made it is gone. */
  sessionId: string | null;
  expanded: boolean;
  onExpanded: (v: boolean) => void;
}) {
  const origin = useMemo(() => (artifact.url ? new URL(artifact.url).origin : null), [artifact.url]);
  const frame = useRef<HTMLIFrameElement>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [showNotes, setShowNotes] = useState(false);
  const [drafting, setDrafting] = useState<(Anchor & Selection) | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  /* The picker needs to be told which window to talk to; it will not guess. */
  const src = origin ? `${artifact.url}#__firetower_ui=${encodeURIComponent(self())}` : undefined;

  const bridge = usePickerBridge(
    frame,
    origin,
    artifact.fromSessionId ?? "",
    null,
    {
      onPath: () => {},
      onSelection: (picked) => {
        const box = frame.current?.getBoundingClientRect() ?? {
          left: 0,
          top: 0,
          width: window.innerWidth,
          height: window.innerHeight,
        };
        setDrafting({
          ...picked,
          quote: picked.snapshot.html.trim().slice(0, 400),
          line: 0,
          label: `Note on ${nameOf(picked.snapshot.label, picked.snapshot.html)}`,
          ...anchorIn(box, picked.snapshot.bounds, picked.point),
        });
      },
      onLocated: () => {},
      onFocusNote: () => setShowNotes(true),
    },
    // The *version*, not the artifact: a note means what it means against the
    // bytes it was written on.
    artifact.id ? `arv:${artifact.id}` : null,
  );

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  /* Esc leaves the expanded view, and leaves annotating before that. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (drafting) return;
      if (bridge.annotating) bridge.tell({ type: "mode", enabled: false });
      else if (expanded) onExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bridge, drafting, expanded, onExpanded]);

  const keep = (text: string) => {
    if (!drafting) return;
    setNotes((held) => [
      ...held,
      {
        id: crypto.randomUUID(),
        what: drafting.snapshot.label,
        html: drafting.snapshot.html,
        text,
        sent: false,
      },
    ]);
    setDrafting(null);
    setShowNotes(true);
    bridge.tell({ type: "clear" });
  };

  const unsent = notes.filter((n) => !n.sent);
  const send = async () => {
    if (!sessionId || unsent.length === 0) return;
    setSending(true);
    const body = `${unsent.length === 1 ? "A note" : `${unsent.length} notes`} on the artifact “${artifact.title}” (v${artifact.version}):\n\n${unsent
      .map((n, i) => `${i + 1}. ${nameOf(n.what, n.html)}\n> ${n.html.replace(/\s+/g, " ").slice(0, 300)}\n\n${n.text}`)
      .join("\n\n")}`;
    try {
      await sendTurn(sessionId, { text: body });
      setNotes((held) => held.map((n) => ({ ...n, sent: true })));
      setNotice("Sent to the agent as one turn.");
    } catch (e) {
      setNotice(why(e) ?? "Could not send those notes.");
    } finally {
      setSending(false);
    }
  };

  if (!origin) return <Plain title="No address for this artifact.">The server could not say where to reach it.</Plain>;

  const body = (
    <div className="relative flex h-full min-h-0 flex-col bg-ground">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel px-2">
        <span className="min-w-0 truncate text-ui font-medium text-bone" title={artifact.title}>
          {artifact.title}
        </span>
        <span className="shrink-0 rounded-full border border-line px-1.5 font-mono text-micro text-mute">
          v{artifact.version}
        </span>
        {artifact.fromWorkspaceName && (
          <span className="shrink-0 truncate text-micro text-mute">from {artifact.fromWorkspaceName}</span>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            disabled={!bridge.ready}
            onClick={() => {
              bridge.tell({ type: "mode", enabled: !bridge.annotating });
              if (!bridge.annotating) setShowNotes(true);
            }}
            title={bridge.ready ? "Pick an element and write a note on it" : "The page has not connected its picker yet"}
            className={`control ${bridge.annotating ? "bg-ember text-ground" : "border border-line bg-raise text-bone hover:bg-overlay"} disabled:opacity-40`}
          >
            {bridge.annotating ? "Annotating" : "Annotate"}
          </button>
          <button
            onClick={() => setShowNotes((v) => !v)}
            className="control plain text-dim hover:bg-raise hover:text-bone"
            title="Notes on this version"
          >
            Notes {notes.length > 0 && <span className="font-mono text-micro">{notes.length}</span>}
          </button>
          <button
            onClick={() => onExpanded(!expanded)}
            title={expanded ? "Collapse (Esc)" : "Fill the window — annotating keeps working"}
            className="grid h-7 w-7 place-items-center rounded-md text-mute hover:bg-raise hover:text-bone"
          >
            {expanded ? <Minimize2 className="h-3.5 w-3.5" strokeWidth={1.75} /> : <Maximize2 className="h-3.5 w-3.5" strokeWidth={1.75} />}
          </button>
          <button
            onClick={() => openExternal(artifact.url)}
            title="Open in the browser — annotating does not work there"
            className="grid h-7 w-7 place-items-center rounded-md text-mute hover:bg-raise hover:text-bone"
          >
            <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1">
          <iframe ref={frame} src={src} title={artifact.title} className="h-full w-full border-0 bg-white" />
        </div>

        {showNotes && (
          <aside className="flex w-[17rem] shrink-0 flex-col border-l border-line bg-panel">
            <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
              <span className="text-meta text-dim">Notes on v{artifact.version}</span>
              <button onClick={() => setShowNotes(false)} className="ml-auto text-mute hover:text-bone">
                ×
              </button>
            </div>
            <div className="scroll-slim min-h-0 flex-1 overflow-y-auto">
              {notes.length === 0 ? (
                <p className="px-4 py-8 text-center text-meta text-mute">
                  {bridge.ready ? "Press Annotate, then click anything in the page." : "Nothing noted yet."}
                </p>
              ) : (
                notes.map((n, i) => (
                  <div key={n.id} className="group/note border-b border-line-soft px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <span
                        className={`grid h-4 w-4 shrink-0 place-items-center rounded-full font-mono text-[10px] leading-none ${n.sent ? "bg-sage-tint text-sage" : "bg-ember-tint text-ember"}`}
                      >
                        {i + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-micro text-mute">{nameOf(n.what, n.html)}</span>
                      {!n.sent && (
                        <button
                          onClick={() => setNotes((held) => held.filter((x) => x.id !== n.id))}
                          className="grid h-5 w-5 place-items-center rounded text-mute opacity-0 group-hover/note:opacity-100 hover:bg-raise hover:text-brick"
                        >
                          <Trash2 className="h-3 w-3" strokeWidth={1.75} />
                        </button>
                      )}
                    </div>
                    <p className="mt-1 text-ui text-text">{n.text}</p>
                    <p className="mt-1 text-micro text-mute">{n.sent ? "sent" : "draft"}</p>
                  </div>
                ))
              )}
            </div>
            {unsent.length > 0 && (
              <div className="shrink-0 border-t border-line p-2.5">
                <button
                  disabled={sending || !sessionId}
                  onClick={send}
                  title={sessionId ? undefined : "The session that made this has ended, so there is nobody to send to."}
                  className="control w-full justify-center bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute"
                >
                  {sending ? <Check className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" strokeWidth={2} />}
                  {sending ? "Sending…" : `Send ${unsent.length} note${unsent.length > 1 ? "s" : ""} to the agent`}
                </button>
              </div>
            )}
          </aside>
        )}
      </div>

      {notice && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 z-30 -translate-x-1/2 rounded-full border border-line bg-overlay px-3.5 py-1.5 text-meta text-dim shadow-(--shadow-float)">
          {notice}
        </div>
      )}

      {drafting && (
        <Annotate
          at={drafting}
          onCancel={() => {
            setDrafting(null);
            bridge.tell({ type: "clear" });
          }}
          onKeep={keep}
          onParent={drafting.parents.length > 0 ? () => bridge.tell({ type: "parent", steps: 1 }) : undefined}
        />
      )}
    </div>
  );

  /* Expanded takes the window. The frame is never unmounted on the way in or
     out — doing that would reload the page and lose the scroll, the picker's
     connection and every note anchored to what is on screen. */
  return expanded ? <div className="fixed inset-0 z-40 bg-ground">{body}</div> : body;
}

function Plain({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center bg-ground">
      <div className="max-w-[26rem] text-center">
        <p className="text-ui text-dim">{title}</p>
        <p className="mt-2 text-meta text-mute">{children}</p>
      </div>
    </div>
  );
}
