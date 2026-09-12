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
import { Check, Copy, Send, X } from "lucide-react";
import { fileAt } from "~/mock/files";
import { highlight, langOf, TONE } from "~/syntax";
import { Annotate, type Anchor } from "~/ui/Annotate";

type Note = { id: number; quote: string; line: number; text: string };

export function FileTab({ path }: { path: string }) {
  const file = fileAt(path);
  const [notes, setNotes] = useState<Note[]>([]);
  const [drafting, setDrafting] = useState<Anchor | null>(null);
  const [reading, setReading] = useState<Note | null>(null);
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
    if (!quote || !body.current || !sel?.anchorNode || sel.rangeCount === 0) return;
    if (!body.current.contains(sel.anchorNode)) return;

    const row = (sel.anchorNode.parentElement as HTMLElement | null)?.closest("[data-line]");
    const line = Number(row?.getAttribute("data-line") ?? 0);

    // Where the selection actually is, so the note opens on top of it.
    const rect = sel.getRangeAt(0).getBoundingClientRect();

    setDrafting({
      quote: quote.length > 400 ? `${quote.slice(0, 400)}…` : quote,
      line,
      x: rect.left + rect.width / 2,
      y: rect.bottom,
    });
  };

  const copy = () => {
    navigator.clipboard?.writeText(file.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-ground">
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
              const noted = notes.filter((x) => x.line === n);
              return (
                <tr key={n} data-line={n} className="group/row">
                  <td
                    className={`sticky left-0 w-12 min-w-12 border-r px-2 text-right align-top tabular-nums select-none ${
                      touched
                        ? "border-sage-deep bg-sage-tint text-sage"
                        : "border-line-soft bg-ground text-mute"
                    }`}
                  >
                    {noted.length > 0 ? (
                      <button
                        onClick={() => setReading(noted[0])}
                        title={noted.map((x) => x.text).join("\n")}
                        className="text-slate hover:text-bone"
                      >
                        ●
                      </button>
                    ) : (
                      n
                    )}
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

      {drafting && (
        <Annotate
          at={drafting}
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

      {/* Kept notes live in the gutter. This is only the count and the way to
          send them — a panel listing them again would repeat what the markers
          already say. */}
      {notes.length > 0 && !drafting && (
        <div className="pointer-events-none absolute right-5 bottom-5 z-30 flex justify-end">
          <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-line bg-overlay py-1.5 pr-1.5 pl-3.5 shadow-(--shadow-float)">
            <span className="text-ui text-dim">
              {notes.length} note{notes.length > 1 ? "s" : ""}
            </span>
            <button
              onClick={() => setNotes([])}
              title="Discard them"
              className="grid h-6 w-6 place-items-center rounded-full text-mute transition-colors hover:bg-raise hover:text-bone"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
            <button
              onClick={() => {
                setNotes([]);
                setSent(true);
                setTimeout(() => setSent(false), 1600);
              }}
              className="control rounded-full bg-bone font-medium text-ground transition-opacity hover:opacity-90"
            >
              <Send className="h-3.5 w-3.5" strokeWidth={2} />
              Send to the agent
            </button>
          </div>
        </div>
      )}

      {reading && (
        <Annotate
          at={{ ...reading, x: window.innerWidth / 2, y: 160 }}
          onCancel={() => setReading(null)}
          onKeep={(text) => {
            setNotes((held) => held.map((x) => (x.id === reading.id ? { ...x, text } : x)));
            setReading(null);
          }}
        />
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
