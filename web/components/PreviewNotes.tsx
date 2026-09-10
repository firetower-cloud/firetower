"use client";
import { useState } from "react";
import {
  usePreviewAnnotations,
  type PreviewAnnotation,
} from "@/src/api/previewAnnotations";

export function PreviewNoteDetails({ note }: { note: PreviewAnnotation }) {
  return (
    <details className="mt-1 text-meta text-mute">
      <summary className="cursor-pointer">Element details</summary>
      <p className="mt-2 break-all">
        {note.snapshot.path} · :{note.port} ·{" "}
        {note.snapshot.viewport.join(" × ")}
      </p>
      <p className="break-all">{note.snapshot.selector}</p>
      <p>Captured {note.snapshot.capturedAt}</p>
      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-ground p-2">
        {note.snapshot.html}
      </pre>
      {note.snapshot.truncated && <p>HTML snapshot truncated.</p>}
    </details>
  );
}

export function PreviewNotes({
  sessionId,
  live,
}: {
  sessionId: string;
  live: boolean;
}) {
  const api = usePreviewAnnotations(sessionId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<PreviewAnnotation | null>(null);
  const [text, setText] = useState("");
  const [expanded, setExpanded] = useState(false);
  const drafts = api.notes.filter((n) => n.delivery === "draft");
  async function act(run: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await run();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not update preview notes.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (!api.notes.length) return null;
  return (
    <section
      className="mb-2 shrink-0 rounded-lg border border-line bg-panel p-3"
      aria-label="Preview feedback"
    >
      <div className="flex items-center gap-2">
        <button
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="text-ui text-dim"
        >
          {expanded ? "▾" : "▸"} {api.notes.length} preview{" "}
          {api.notes.length === 1 ? "note" : "notes"}
        </button>
        <button
          disabled={busy || !live || !drafts.length || !!editing}
          onClick={() => act(() => api.send(drafts))}
          className="ml-auto rounded-md bg-bone px-3 py-2 text-ui text-ground disabled:opacity-50"
        >
          {busy ? "Working…" : "Send to agent ↑"}
        </button>
      </div>
      {expanded && (
        <ol className="mt-2 max-h-64 space-y-2 overflow-y-auto">
          {api.notes.map((note, i) => (
            <li key={note.id} className="rounded-md border border-line p-2">
              <p className="text-ui text-dim">
                {i + 1}. {note.snapshot.label}
              </p>
              {editing?.id === note.id ? (
                <>
                  <textarea
                    aria-label="Edit preview note"
                    className="mt-2 w-full rounded-md bg-ground p-2 text-ui text-text"
                    value={text}
                    maxLength={8000}
                    onChange={(e) => setText(e.target.value)}
                  />
                  <button
                    disabled={busy || !text.trim()}
                    className="text-meta text-dim"
                    onClick={() =>
                      act(async () => {
                        await api.keep({ ...editing, note: text });
                        setEditing(null);
                      })
                    }
                  >
                    Save
                  </button>{" "}
                  <button
                    className="text-meta text-mute"
                    onClick={() => setEditing(null)}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <p className="whitespace-pre-wrap text-ui text-text">
                  {note.note}
                </p>
              )}
              <PreviewNoteDetails note={note} />
              {note.delivery !== "draft" && (
                <p className="mt-2 text-meta text-brick">
                  Delivery{" "}
                  {note.delivery === "sending"
                    ? "pending or unconfirmed"
                    : "unconfirmed"}
                  . Check the conversation before resending.
                </p>
              )}
              <div className="mt-2 flex gap-3 text-meta text-mute">
                {note.delivery === "draft" && (
                  <button
                    disabled={busy}
                    onClick={() => {
                      setEditing(note);
                      setText(note.note);
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
      )}
      {error && (
        <p role="alert" className="mt-2 text-meta text-brick">
          {error}
        </p>
      )}
    </section>
  );
}
