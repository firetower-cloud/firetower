"use client";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  annotationRequest,
  snapshotSchema,
  usePreviewAnnotations,
  type ElementSnapshot,
  type PreviewAnnotation,
} from "@/src/api/previewAnnotations";
import { PreviewNoteDetails } from "@/components/PreviewNotes";

type Connection = { session: string; port: number; origin: string };
type Selection = { snapshot: ElementSnapshot; parents: string[] };
const button =
  "rounded-md border border-line px-3 py-2 text-ui text-dim disabled:opacity-50";

export default function Page() {
  const [connection, setConnection] = useState<Connection | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    try {
      const origin = new URL(params.get("origin") || "").origin;
      const session = params.get("session") || "";
      const port = Number(params.get("port"));
      if (
        /^s_[a-zA-Z0-9_-]+$/.test(session) &&
        Number.isInteger(port) &&
        port > 0 &&
        port < 65536 &&
        /^https?:/.test(origin)
      ) {
        // Browser query parameters are available only after hydration.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setConnection({ session, port, origin });
      }
    } catch {
      /* Invalid links never start a bridge. */
    }
  }, []);
  return connection ? (
    <Panel connection={connection} />
  ) : (
    <p className="p-4 text-ui text-mute">
      Open annotations from a Firetower preview to connect this panel.
    </p>
  );
}

function Panel({ connection: c }: { connection: Connection }) {
  const address = useQuery({
    queryKey: ["annotation-preview-address", c.session, c.port],
    queryFn: () =>
      annotationRequest<{ url: string }>(
        `/api/v1/sessions/${encodeURIComponent(c.session)}/preview?port=${c.port}`,
      ),
    retry: false,
  });
  const verified =
    !!address.data && new URL(address.data.url).origin === c.origin;
  const api = usePreviewAnnotations(c.session, verified);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [comment, setComment] = useState("");
  const [editing, setEditing] = useState<PreviewAnnotation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const bridge = useRef<{ target: Window; channel: string } | null>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const draftKey = `firetower.preview-draft.${c.session}.${c.port}`;
  const loaded = useRef(false);
  const currentDraft = useRef({ comment, selection, editing });
  useEffect(() => {
    currentDraft.current = { comment, selection, editing };
  }, [comment, selection, editing]);
  const savingId = useRef<string | null>(null);
  function tell(type: string, data: Record<string, unknown> = {}) {
    const b = bridge.current;
    if (b)
      b.target.postMessage(
        { source: "firetower-panel", channel: b.channel, type, ...data },
        c.origin,
      );
  }
  useEffect(() => {
    if (!verified) return;
    const target = window.parent !== window ? window.parent : window.opener;
    if (!target) return;
    const channel = crypto.randomUUID();
    bridge.current = { target, channel };
    const hello = () =>
      target.postMessage(
        { source: "firetower-panel", channel, type: "hello" },
        c.origin,
      );
    const listener = (event: MessageEvent) => {
      const d = event.data;
      if (
        event.origin !== c.origin ||
        event.source !== target ||
        !d ||
        d.source !== "firetower-picker" ||
        d.channel !== channel
      )
        return;
      if (d.type === "ready" && d.session === c.session && d.port === c.port) {
        setReady(true);
        setMode(d.enabled === true);
      }
      if (d.type === "mode") setMode(d.enabled === true);
      if (d.type === "selection") {
        const parsed = snapshotSchema.safeParse(d.snapshot);
        if (
          !parsed.success ||
          !Array.isArray(d.parents) ||
          d.parents.length > 10 ||
          d.parents.some(
            (p: unknown) => typeof p !== "string" || p.length > 500,
          )
        )
          return;
        // Keep the user's text if they adjust the parent selection. Editing an
        // existing note never silently changes its captured element.
        if (currentDraft.current.editing) {
          setNotice(
            "Save or cancel your edit before choosing another element.",
          );
          return;
        }
        setSelection({ snapshot: parsed.data, parents: d.parents });
        savingId.current = null;
        setTimeout(() => commentRef.current?.focus({ preventScroll: true }), 0);
      }
      if (d.type === "located")
        setNotice(
          d.found
            ? "Element highlighted in the preview."
            : "Element changed or is on another page. The captured context is kept.",
        );
      if (d.type === "focus-note" && typeof d.id === "string")
        document
          .getElementById(`note-${d.id}`)
          ?.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("message", listener);
    hello();
    const timer = setInterval(hello, 2000);
    return () => {
      clearInterval(timer);
      window.removeEventListener("message", listener);
      bridge.current = null;
    };
  }, [verified, c.origin, c.session, c.port]);
  useEffect(() => {
    if (!verified || loaded.current) return;
    loaded.current = true;
    try {
      const raw = JSON.parse(localStorage.getItem(draftKey) || "null");
      const parsed = snapshotSchema.safeParse(raw?.selection?.snapshot);
      if (parsed.success && typeof raw.comment === "string") {
        // Restore a local unsaved draft once; kept notes come from the server.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSelection({ snapshot: parsed.data, parents: [] });
        setComment(raw.comment.slice(0, 8000));
      }
    } catch {
      /* Storage may be blocked in an embedded panel. */
    }
  }, [verified, draftKey]);
  useEffect(() => {
    if (!loaded.current) return;
    try {
      if (selection && !editing)
        localStorage.setItem(draftKey, JSON.stringify({ selection, comment }));
      else localStorage.removeItem(draftKey);
    } catch {
      /* Kept drafts are durable on the server. */
    }
  }, [selection, comment, editing, draftKey]);
  useEffect(() => {
    const b = bridge.current;
    if (!b || !ready) return;
    b.target.postMessage(
      {
        source: "firetower-panel",
        channel: b.channel,
        type: "pins",
        pins: api.notes
          .filter((n) => n.port === c.port)
          .map((n) => ({
            id: n.id,
            path: n.snapshot.path,
            selector: n.snapshot.selector,
            label: n.snapshot.label,
            html: n.snapshot.html,
          })),
      },
      c.origin,
    );
  }, [api.data, api.notes, c.port, c.origin, ready]);
  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update feedback.");
    } finally {
      setBusy(false);
    }
  }
  async function keep() {
    if (!selection || !comment.trim()) return;
    await act(async () => {
      savingId.current ||= crypto.randomUUID();
      await api.keep({
        id: editing?.id || savingId.current,
        port: c.port,
        snapshot: selection.snapshot,
        note: comment,
        revision: editing?.revision || 0,
      });
      setComment("");
      setSelection(null);
      setEditing(null);
      savingId.current = null;
      tell("clear");
      setNotice("Note kept. It will stay here until you send it.");
    });
  }
  const drafts = api.notes.filter(
    (n) => n.port === c.port && n.delivery === "draft",
  );
  const notes = api.notes.filter((n) => n.port === c.port);
  if (address.isPending)
    return <p className="p-4 text-ui text-mute">Connecting to Firetower…</p>;
  if (address.error)
    return (
      <div className="space-y-3 p-4 text-ui text-text">
        <p>
          Sign in to Firetower to connect this preview. If browser storage is
          blocked, open the feedback panel in a separate window.
        </p>
        <p className="text-meta text-mute">{address.error.message}</p>
        <a className={button} href="/login" target="_blank" rel="noreferrer">
          Sign in ↗
        </a>{" "}
        <button className={button} onClick={() => address.refetch()}>
          Reconnect
        </button>
      </div>
    );
  if (!verified)
    return (
      <p role="alert" className="p-4 text-ui text-brick">
        This preview does not belong to the selected Firetower session. Open it
        again from Firetower.
      </p>
    );
  return (
    <main className="flex h-dvh flex-col bg-panel p-3 text-text">
      <header className="flex shrink-0 items-center gap-2">
        <strong className="text-ui">Firetower · :{c.port}</strong>
        <a
          href={`/sessions/${c.session}`}
          target="_blank"
          rel="noreferrer"
          className="ml-auto text-meta text-mute"
        >
          Conversation ↗
        </a>
      </header>
      <div className="my-3 flex shrink-0 gap-2">
        <button
          className={button}
          disabled={!ready}
          aria-pressed={mode}
          onClick={() => tell("mode", { enabled: !mode })}
        >
          {mode ? "● Annotating · Browse" : "Annotate"}
        </button>
        <span className="self-center text-meta text-mute">
          {ready ? "Esc to browse" : "Waiting for preview connection…"}
        </span>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
        {selection ? (
          <section className="rounded-lg border border-line p-3">
            <p className="break-all text-ui text-dim">
              {selection.snapshot.label}
            </p>
            {!!selection.parents.length && !editing && (
              <div className="my-2 flex flex-wrap gap-1">
                <button
                  className={button}
                  onClick={() => tell("parent", { steps: 1 })}
                >
                  Select parent ↑
                </button>
                <select
                  aria-label="Select an ancestor"
                  className="min-w-0 max-w-full rounded-md bg-ground p-2 text-meta"
                  value=""
                  onChange={(e) => {
                    if (e.target.value)
                      tell("parent", { steps: Number(e.target.value) });
                  }}
                >
                  <option value="">Choose ancestor…</option>
                  {selection.parents.map((p, i) => (
                    <option key={i} value={i + 1}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <textarea
              ref={commentRef}
              aria-label="Annotation comment"
              placeholder="What should change?"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              maxLength={8000}
              rows={3}
              className="mt-2 w-full resize-y rounded-md border border-line bg-ground p-2 text-ui text-text"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (!busy) void keep();
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  tell("mode", { enabled: false });
                }
              }}
            />
            <div className="mt-2 flex gap-2">
              <button
                className={button}
                disabled={busy || !comment.trim()}
                onClick={keep}
              >
                {editing ? "Save" : "Keep ↵"}
              </button>
              <button
                className={button}
                disabled={busy}
                onClick={() => {
                  setSelection(null);
                  setComment("");
                  setEditing(null);
                  savingId.current = null;
                  tell("clear");
                }}
              >
                Cancel
              </button>
            </div>
          </section>
        ) : (
          <p className="text-ui text-mute">
            Enter annotation mode, then select an element on the page. Use
            Select parent to choose its card or section.
          </p>
        )}
        <ol className="space-y-2">
          {notes.map((note, i) => (
            <li
              id={`note-${note.id}`}
              key={note.id}
              className="rounded-lg border border-line p-3"
            >
              <button
                className="break-all text-left text-ui text-dim"
                disabled={!ready}
                onClick={() => tell("locate", { id: note.id })}
              >
                {i + 1}. {note.snapshot.label}
              </button>
              <p className="mt-1 whitespace-pre-wrap text-ui">{note.note}</p>
              <PreviewNoteDetails note={note} />
              {note.delivery !== "draft" && (
                <p className="mt-2 text-meta text-brick">
                  Delivery pending or unconfirmed. Check the conversation before
                  sending again.
                </p>
              )}
              <div className="mt-2 flex gap-3 text-meta text-mute">
                {note.delivery === "draft" && (
                  <button
                    disabled={busy || !!selection}
                    onClick={() => {
                      setEditing(note);
                      setSelection({ snapshot: note.snapshot, parents: [] });
                      setComment(note.note);
                    }}
                  >
                    Edit
                  </button>
                )}
                {note.delivery !== "sending" && (
                  <button
                    disabled={busy}
                    onClick={() => act(() => api.drop([note]))}
                  >
                    Remove
                  </button>
                )}
              </div>
            </li>
          ))}
        </ol>
        {(error || api.error) && (
          <p role="alert" className="text-ui text-brick">
            {error || api.error?.message}
          </p>
        )}
        {notice && (
          <p role="status" className="text-ui text-dim">
            {notice}
          </p>
        )}
      </div>
      <footer className="mt-3 shrink-0 border-t border-line pt-3">
        <button
          className="w-full rounded-md bg-bone px-3 py-2 text-ui font-medium text-ground disabled:opacity-50"
          disabled={busy || !drafts.length || !!selection}
          onClick={() =>
            act(async () => {
              await api.send(drafts);
              setNotice(
                "Sent to agent. View the conversation for the response.",
              );
            })
          }
        >
          {busy
            ? "Working…"
            : `Send ${drafts.length} ${drafts.length === 1 ? "note" : "notes"} to agent ↑`}
        </button>
        <p className="mt-1 text-meta text-mute">
          Kept until you send. Selected HTML and location are included.
        </p>
      </footer>
    </main>
  );
}
