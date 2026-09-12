/**
 * A file out of the workspace, as something to read and argue with.
 *
 * This is where a plan gets reviewed. Agents write plans and specs to files,
 * and reading one in a transcript has two problems: it scrolls away, and it is
 * gone the moment the conversation moves on. A file has neither — it stays open
 * beside the conversation while the agent works, and the notes written against
 * it go back as an ordinary message.
 *
 * The gutter marks what this session wrote, so "what did it change in here"
 * is answered without leaving for the diff.
 */
import { useMemo, useRef, useState } from "react";
import { Check, Copy, MessageSquarePlus, Send, X } from "lucide-react";
import { fileAt } from "~/mock/files";
import { highlight, langOf, TONE } from "~/syntax";

type Note = { id: number; quote: string; line: number; text: string };

export function FileTab({ path }: { path: string }) {
  const file = fileAt(path);
  const [notes, setNotes] = useState<Note[]>([]);
  const [drafting, setDrafting] = useState<{ quote: string; line: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState(false);
  const body = useRef<HTMLDivElement>(null);

  const lines = useMemo(() => (file ? file.text.replace(/\n$/, "").split("\n") : []), [file]);
  /* Clamped to the file: a fixture that claims more touched lines than the
     file has would print "33 lines, 40 touched", which is the kind of small
     lie that makes a reader stop trusting the rest of the screen. */
  const changed = useMemo(
    () => new Set((file?.changed ?? []).filter((n) => n >= 1 && n <= lines.length)),
    [file, lines.length],
  );
  const lang = file?.lang ?? langOf(path);

  if (!file) {
    return (
      <div className="grid h-full place-items-center bg-ground">
        <div className="max-w-[22rem] text-center">
          <p className="font-mono text-ui text-dim">{path}</p>
          <p className="mt-2 text-meta text-mute">
            Not in the fixtures. The real client reads it off the worker.
          </p>
        </div>
      </div>
    );
  }

  /* A quote is what you selected, and the line it started on is where the note
     is pinned — the same shape the conversation's annotations use, so a note
     against a file and a note against a message go back the same way. */
  const takeSelection = () => {
    const sel = window.getSelection();
    const quote = sel?.toString().trim();
    if (!quote || !body.current || !sel?.anchorNode) return;
    if (!body.current.contains(sel.anchorNode)) return;

    const row = (sel.anchorNode.parentElement as HTMLElement | null)?.closest("[data-line]");
    const line = Number(row?.getAttribute("data-line") ?? 0);
    setDrafting({ quote: quote.length > 240 ? `${quote.slice(0, 240)}…` : quote, line });
  };

  const copy = () => {
    navigator.clipboard?.writeText(file.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-ground">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        <span className="min-w-0 flex-1 truncate font-mono text-meta text-slate" title={path}>
          {path}
        </span>
        <span className="shrink-0 font-mono text-micro text-mute">
          {lines.length} lines
          {changed.size > 0 && <span className="ml-2 text-sage">{changed.size} touched</span>}
        </span>
        <button
          onClick={copy}
          title="Copy the file"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-mute transition-colors hover:bg-raise hover:text-bone"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-sage" strokeWidth={2} />
          ) : (
            <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />
          )}
        </button>
      </header>

      <div
        ref={body}
        onMouseUp={takeSelection}
        className="scroll-slim min-h-0 flex-1 overflow-auto py-2"
      >
        <table className="w-max min-w-full border-separate border-spacing-0 font-mono text-code">
          <tbody>
            {lines.map((line, i) => {
              const n = i + 1;
              const touched = changed.has(n);
              return (
                <tr key={n} data-line={n} className="group/row">
                  <td
                    className={`sticky left-0 w-12 min-w-12 border-r px-2 text-right align-top tabular-nums select-none ${
                      touched
                        ? "border-sage-deep bg-sage-tint text-sage"
                        : "border-line-soft bg-ground text-mute"
                    }`}
                  >
                    {n}
                  </td>
                  <td className={`px-3 whitespace-pre ${touched ? "bg-sage-tint/25" : ""}`}>
                    {line === "" ? (
                      " "
                    ) : (
                      highlight(line, lang).map((p, k) => (
                        <span key={k} className={TONE[p.kind]}>
                          {p.text}
                        </span>
                      ))
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {(drafting || notes.length > 0) && (
        <div className="shrink-0 border-t border-line bg-panel">
          {drafting && (
            <Drafting
              quote={drafting.quote}
              onCancel={() => setDrafting(null)}
              onKeep={(text) => {
                setNotes((held) => [
                  ...held,
                  { id: Date.now(), quote: drafting.quote, line: drafting.line, text },
                ]);
                setDrafting(null);
                window.getSelection()?.removeAllRanges();
              }}
            />
          )}

          {notes.length > 0 && !drafting && (
            <div className="px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span className="text-ui text-dim">
                  {notes.length} note{notes.length > 1 ? "s" : ""} on this file
                </span>
                <button
                  onClick={() => {
                    setNotes([]);
                    setSent(true);
                    setTimeout(() => setSent(false), 1600);
                  }}
                  className="control ml-auto border border-line bg-raise text-bone hover:bg-overlay"
                >
                  <Send className="h-3.5 w-3.5" strokeWidth={1.75} />
                  Send to the agent
                </button>
              </div>

              <div className="mt-2 space-y-1.5">
                {notes.map((note) => (
                  <div key={note.id} className="flex items-start gap-2 rounded-md bg-ground px-2.5 py-2">
                    <span className="shrink-0 font-mono text-micro text-mute">L{note.line}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-micro text-mute">
                        {note.quote}
                      </span>
                      <span className="block text-meta text-text">{note.text}</span>
                    </span>
                    <button
                      onClick={() => setNotes((h) => h.filter((x) => x.id !== note.id))}
                      className="grid h-5 w-5 shrink-0 place-items-center rounded text-mute hover:bg-raise hover:text-bone"
                    >
                      <X className="h-3 w-3" strokeWidth={2} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {sent && (
        <div className="flex h-8 shrink-0 items-center gap-2 border-t border-line bg-panel px-3 text-meta text-sage">
          <Check className="h-3.5 w-3.5" strokeWidth={2} />
          Sent. The agent has the notes and the lines they were on.
        </div>
      )}
    </div>
  );
}

function Drafting({
  quote,
  onKeep,
  onCancel,
}: {
  quote: string;
  onKeep: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  return (
    <div className="px-3 py-2.5">
      <div className="flex items-start gap-2">
        <MessageSquarePlus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate" strokeWidth={1.75} />
        <span className="min-w-0 flex-1 truncate border-l-2 border-slate-deep pl-2 font-mono text-micro text-mute">
          {quote}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && text.trim()) onKeep(text.trim());
            if (e.key === "Escape") onCancel();
          }}
          placeholder="What about it?"
          className="min-w-0 flex-1 rounded-lg border border-line bg-ground px-3 py-1.5 text-ui text-bone placeholder:text-mute focus:border-slate-deep focus:outline-none"
        />
        <button
          disabled={!text.trim()}
          onClick={() => text.trim() && onKeep(text.trim())}
          className="control border border-line bg-raise text-bone hover:bg-overlay disabled:text-mute"
        >
          Keep
        </button>
        <button onClick={onCancel} className="control text-mute hover:text-dim">
          Cancel
        </button>
      </div>
    </div>
  );
}
