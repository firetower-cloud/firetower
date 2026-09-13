/**
 * The application this session is running, in a tab of its own.
 *
 * The frame points at the session's preview hostname — a real origin the
 * control plane serves by name, so routers, sockets and hot reload all work
 * because none of them can tell. That also means nothing here can look inside
 * it. What can is the picker the control plane injects into the page, and
 * this tab is the panel it talks to (`preview/bridge`): pick an element in
 * there, write the note here, in the same popover a file gets.
 *
 * Notes live on the control plane and go to the agent as one turn. The
 * column on the right is that list, with what has been sent and what is still
 * a draft.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, Monitor, RotateCw, Send, Smartphone, Tablet, Trash2 } from "lucide-react";
import { usePreviewAddress } from "@/src/api/generated/sessions/sessions";
import type { PreviewAnnotation, Session } from "@/src/api/generated/model";
import { elapsed, minutesSince } from "@/src/api/view";
import { isLive } from "~/mock/http";
import { why } from "~/data";
import { openExternal } from "~/open";
import { Annotate, type Anchor } from "~/ui/Annotate";
import { usePickerBridge, type Selection } from "~/preview/bridge";
import { usePreviewNotes } from "~/preview/notes";

const WIDTHS = [
  { id: "full", label: "Full width", icon: Monitor, px: 0 },
  { id: "tablet", label: "Tablet · 820", icon: Tablet, px: 820 },
  { id: "phone", label: "Phone · 390", icon: Smartphone, px: 390 },
] as const;

/** What an element is, for a person: its tag and a little of its text. */
function nameOf(label: string, html: string): string {
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text ? `<${label}> ${text.length > 40 ? `${text.slice(0, 40)}…` : text}` : `<${label}>`;
}

/** Where this app is, as an origin the picker will accept. A custom scheme's `origin` reads "null". */
const self = () => (location.origin && location.origin !== "null" ? location.origin : `${location.protocol}//${location.host}`);

export function PreviewTab({ session, port, path: initialPath = "/", onPath }: { session: Session; port: number; path?: string; onPath?: (path: string) => void }) {
  const live = isLive();
  const ended = session.status === "Ended";
  const address = usePreviewAddress(session.id, { port }, { query: { enabled: live && !ended, retry: false } });
  const url = address.data?.url ?? null;
  const origin = useMemo(() => (url ? new URL(url).origin : null), [url]);
  /* Where the page is. The frame is another origin, so this is what the page
     says through the picker; a reload goes back to it rather than to `/`. */
  const [path, setPath] = useState(initialPath);
  const [typed, setTyped] = useState<string | null>(null);
  const at = (p: string) => `${origin}${p}${p.includes("#") ? "&" : "#"}__firetower_ui=${encodeURIComponent(self())}`;

  const frame = useRef<HTMLIFrameElement>(null);
  const [reloads, setReloads] = useState(0);
  /* What the frame is pointed at. Set on open and on reload only — never
     from the path the page reports, or reporting it would move the frame,
     which would report it again. */
  const pathRef = useRef(path);
  pathRef.current = path;
  const launch = useMemo(() => (origin ? at(pathRef.current) : null), [origin, reloads]); // eslint-disable-line react-hooks/exhaustive-deps
  const [width, setWidth] = useState<(typeof WIDTHS)[number]["id"]>("full");
  const [drafting, setDrafting] = useState<(Anchor & Selection) | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);

  const notes = usePreviewNotes(session.id, port, live && !ended);

  const bridge = usePickerBridge(frame, origin, session.id, port, {
    onPath: (p) => {
      setPath(p);
      onPath?.(p);
    },
    onSelection: (picked) => {
      const box = frame.current?.getBoundingClientRect();
      const [x, y, w, h] = picked.snapshot.bounds;
      setDrafting({
        ...picked,
        quote: picked.snapshot.html.trim().slice(0, 400),
        line: 0,
        label: `Note on ${nameOf(picked.snapshot.label, picked.snapshot.html)} · ${picked.snapshot.path}`,
        x: (box?.left ?? 0) + x + w / 2,
        y: (box?.top ?? 0) + y + h,
      });
    },
    onLocated: (_id, found) => setNotice(found ? null : "That element is not on this page any more. The note keeps what it captured."),
    onFocusNote: (id) => {
      setFocused(id);
      document.getElementById(`preview-note-${id}`)?.scrollIntoView({ block: "nearest" });
    },
  });

  /* Pins follow the notes: the picker draws one on each element it can still find. */
  useEffect(() => {
    if (!bridge.ready) return;
    bridge.tell({ type: "pins", pins: notes.notes.map((n) => ({ id: n.id, path: n.snapshot.path, selector: n.snapshot.selector, label: n.snapshot.label, html: n.snapshot.html })) });
  }, [bridge.ready, notes.notes, bridge.tell]);

  useEffect(() => {
    if (!bridge.annotating) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !drafting) bridge.tell({ type: "mode", enabled: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bridge.annotating, drafting, bridge.tell]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const keep = (text: string) => {
    if (!drafting) return;
    notes.keep.mutate(
      { id: crypto.randomUUID(), port, snapshot: drafting.snapshot, note: text, revision: 0 },
      { onSuccess: () => bridge.tell({ type: "clear" }), onError: (e) => setNotice(why(e) ?? "Could not keep that note.") },
    );
    setDrafting(null);
  };

  if (!live) return <Plain title="Previews need a connected server.">A fixture has nothing running in it.</Plain>;
  if (ended) return <Plain title="This session has ended.">There is nothing running on port {port} any more.</Plain>;
  if (address.isPending) return <Plain title={`Finding port ${port}…`}>Asking the server where this session can be reached.</Plain>;
  if (address.error || !url) return <Plain title="No address for this port.">{address.error ? why(address.error) : "The server could not say where to reach it."}</Plain>;

  const drafts = notes.notes.filter((n) => n.delivery === "draft");
  const frameWidth = WIDTHS.find((w) => w.id === width)!.px;

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-ground">
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-line bg-panel px-2">
        <button disabled={!bridge.ready} onClick={() => bridge.tell({ type: "go", delta: -1 })} title="Back" className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-mute hover:bg-raise hover:text-bone disabled:opacity-40">
          <ChevronLeft className="h-4 w-4" strokeWidth={1.75} />
        </button>
        <button disabled={!bridge.ready} onClick={() => bridge.tell({ type: "go", delta: 1 })} title="Forward" className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-mute hover:bg-raise hover:text-bone disabled:opacity-40">
          <ChevronRight className="h-4 w-4" strokeWidth={1.75} />
        </button>
        {/* In place when the page can hear us — its history survives. A page
            without the picker (or one that has not connected) is remounted. */}
        <button onClick={() => (bridge.ready ? bridge.tell({ type: "reload" }) : setReloads((n) => n + 1))} title="Reload" className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-mute hover:bg-raise hover:text-bone">
          <RotateCw className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
        {/* The host is fixed and long (a session id, a port, a signature), so
            only the port is shown for it; the path is yours to change. */}
        <div className="ml-1 flex min-w-0 flex-1 items-center gap-1 rounded-md border border-line bg-ground px-2 font-mono text-meta focus-within:border-mute">
          <span className="shrink-0 text-mute" title={url}>:{port}</span>
          <input
            value={typed ?? path}
            onChange={(e) => setTyped(e.target.value)}
            onBlur={() => setTyped(null)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setTyped(null);
              if (e.key === "Enter" && typed !== null) {
                const next = typed.startsWith("/") ? typed : `/${typed}`;
                setPath(next);
                onPath?.(next);
                setTyped(null);
                if (bridge.ready) bridge.tell({ type: "navigate", path: next });
                else setReloads((n) => n + 1);
              }
            }}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent py-1 text-dim focus:text-bone focus:outline-none"
          />
        </div>

        <div className="track ml-2 shrink-0">
          {WIDTHS.map((w) => (
            <button key={w.id} data-on={width === w.id} onClick={() => setWidth(w.id)} title={w.label}>
              <w.icon className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
          ))}
        </div>

        <button
          disabled={!bridge.ready}
          onClick={() => bridge.tell({ type: "mode", enabled: !bridge.annotating })}
          title={bridge.ready ? (bridge.annotating ? "Stop picking elements" : "Pick an element and write a note on it") : "The page has not connected its picker yet — reload, or the page may refuse scripts"}
          className={`control ml-1 shrink-0 ${bridge.annotating ? "bg-ember text-ground" : "border border-line bg-raise text-bone hover:bg-overlay"} disabled:opacity-40`}
        >
          {bridge.annotating ? "Annotating" : "Annotate"}
        </button>
        <button onClick={() => launch && openExternal(launch)} title="Open in the browser" className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-mute hover:bg-raise hover:text-bone">
          <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className={`min-h-0 min-w-0 flex-1 ${frameWidth ? "flex justify-center bg-panel/60 py-3" : ""}`}>
          <iframe
            key={reloads}
            ref={frame}
            src={launch ?? undefined}
            title={`Port ${port} in this session`}
            style={frameWidth ? { width: frameWidth, maxWidth: "100%" } : undefined}
            className={`h-full border-0 bg-white ${frameWidth ? "rounded-lg shadow-(--shadow-float)" : "w-full"}`}
          />
        </div>

        <aside className="flex w-[18rem] shrink-0 flex-col border-l border-line bg-panel">
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
            <span className="text-meta text-dim">Notes on :{port}</span>
            {notes.notes.length > 0 && <span className="font-mono text-micro text-mute">{notes.notes.length}</span>}
          </div>
          <div className="scroll-slim min-h-0 flex-1 overflow-y-auto">
            {notes.notes.length === 0 ? (
              <p className="px-4 py-8 text-center text-meta text-mute">{bridge.ready ? "Press Annotate, then click anything in the page." : "Nothing noted yet."}</p>
            ) : (
              notes.notes.map((n, i) => (
                <Note
                  key={n.id}
                  index={i + 1}
                  note={n}
                  focused={focused === n.id}
                  onLocate={() => bridge.tell({ type: "locate", id: n.id })}
                  onEdit={(text) => notes.keep.mutate({ id: n.id, port, snapshot: n.snapshot, note: text, revision: n.revision }, { onError: (e) => setNotice(why(e) ?? "Could not change that note.") })}
                  onDrop={() => notes.drop.mutate([n], { onError: (e) => setNotice(why(e) ?? "Could not remove that note.") })}
                />
              ))
            )}
          </div>
          {drafts.length > 0 && (
            <div className="shrink-0 border-t border-line p-2.5">
              <button
                disabled={notes.send.isPending}
                onClick={() => notes.send.mutate(drafts, { onError: (e) => setNotice(why(e) ?? "Could not send those notes.") })}
                className="control w-full justify-center bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute"
              >
                <Send className="h-3.5 w-3.5" strokeWidth={2} />
                {notes.send.isPending ? "Sending…" : `Send ${drafts.length} note${drafts.length > 1 ? "s" : ""} to the agent`}
              </button>
            </div>
          )}
        </aside>
      </div>

      {notice && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 z-30 -translate-x-1/2 rounded-full border border-line bg-overlay px-3.5 py-1.5 text-meta text-dim shadow-(--shadow-float)">{notice}</div>
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
}

/** One note, where it is and whether the agent has it. */
function Note({ index, note, focused, onLocate, onEdit, onDrop }: { index: number; note: PreviewAnnotation; focused: boolean; onLocate: () => void; onEdit: (text: string) => void; onDrop: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const sent = note.delivery === "sent";
  const pending = note.delivery !== "draft" && !sent;
  const when = note.snapshot.capturedAt ? elapsed(minutesSince(note.snapshot.capturedAt)) : null;
  return (
    <div id={`preview-note-${note.id}`} className={`group/note border-b border-line-soft px-3 py-2.5 ${focused ? "bg-raise/60" : ""}`}>
      <button onClick={onLocate} title={`${note.snapshot.path} · ${note.snapshot.selector}`} className="flex w-full items-center gap-2 text-left">
        <span className={`grid h-4 w-4 shrink-0 place-items-center rounded-full font-mono text-[10px] leading-none ${sent ? "bg-sage-tint text-sage" : pending ? "bg-slate-tint text-slate" : "bg-ember-tint text-ember"}`}>{index}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-micro text-mute">{nameOf(note.snapshot.label, note.snapshot.html)}</span>
      </button>
      {editing !== null ? (
        <textarea
          autoFocus
          rows={2}
          value={editing}
          onChange={(e) => setEditing(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setEditing(null);
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (editing.trim()) onEdit(editing.trim());
              setEditing(null);
            }
          }}
          className="scroll-slim mt-1.5 w-full resize-none rounded-md border border-line bg-ground px-2 py-1 text-ui text-bone focus:outline-none"
        />
      ) : (
        <p onDoubleClick={() => !sent && setEditing(note.note)} className="mt-1 text-ui text-text">{note.note}</p>
      )}
      <div className="mt-1 flex items-center gap-2 text-micro text-mute">
        <span>{sent ? "sent" : pending ? "sending…" : "draft"}{when ? ` · ${when} ago` : ""}</span>
        {!sent && (
          <button onClick={onDrop} title="Remove" className="ml-auto grid h-5 w-5 place-items-center rounded opacity-0 transition-opacity group-hover/note:opacity-100 hover:bg-raise hover:text-brick">
            <Trash2 className="h-3 w-3" strokeWidth={1.75} />
          </button>
        )}
      </div>
    </div>
  );
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

