/**
 * A file out of the workspace, as something to read and argue with.
 *
 * On a connected server the bytes come off the worker through the web build's
 * `useFileText`, which already decides the three things worth deciding —
 * text, binary, or too big to draw — and refreshes while an agent is editing.
 * Markdown renders; everything else gets the syntax layer and a gutter.
 *
 * Selecting code starts a note, pinned to the line it came from, sent back as
 * an ordinary message. The same shape the conversation's annotations use.
 */
import { useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, Copy, Send, X } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { isMarkdown, useFileText } from "@/src/api/text";
import { sendTurn } from "@/src/api/generated/sessions/sessions";
import type { Session } from "@/src/api/generated/model";
import { fileAt } from "~/mock/files";
import { highlight, langOf, TONE } from "~/syntax";
import { isLive } from "~/mock/http";
import { Annotate, type Anchor } from "~/ui/Annotate";
import { addedLines } from "~/patch";
import { useDiff } from "~/data";

type Note = { id: number; quote: string; line: number; text: string };

import { why } from "~/data";

export function FileTab({ session, path }: { session: Session; path: string }) {
  const sessionId = session.id;
  const live = isLive();
  const diff = useDiff(live ? session : null, "Head");
  const mine = useMemo(() => diff.data.find((d) => d.at === path), [diff.data, path]);
  const remote = useFileText(live ? sessionId : "", path);
  const fixture = live ? null : fileAt(path);

  const text = live ? (remote.data?.kind === "text" ? remote.data.text : null) : (fixture?.text ?? null);
  const lines = useMemo(() => (text ? text.replace(/\n$/, "").split("\n") : []), [text]);
  /* The lines this session added, so the file shows its own edits. A fixture
     says so outright; a real file says it through the session's patch. */
  const touched = useMemo(() => {
    const from = live ? (mine ? [...addedLines(mine.patch)] : []) : (fixture?.changed ?? []);
    return new Set(from.filter((n) => n >= 1 && n <= lines.length));
  }, [live, mine, fixture, lines.length]);
  const lang = fixture?.lang ?? langOf(path);

  const [notes, setNotes] = useState<Note[]>([]);
  const [drafting, setDrafting] = useState<Anchor | null>(null);
  const [reading, setReading] = useState<Note | null>(null);
  const [copied, setCopied] = useState(false);
  const [rendered, setRendered] = useState(true);
  const body = useRef<HTMLDivElement>(null);

  const send = useMutation({
    mutationFn: () =>
      sendTurn(sessionId, {
        text: `On \`${path}\`:\n\n${notes.map((n, i) => `${i + 1}. Line ${n.line}:\n> ${n.quote.split("\n").join("\n> ")}\n\n${n.text}`).join("\n\n")}`,
        images: [],
      }),
    onSuccess: () => setNotes([]),
  });

  const takeSelection = () => {
    const sel = window.getSelection();
    const quote = sel?.toString().trim();
    if (!quote || !body.current || !sel?.anchorNode || sel.rangeCount === 0) return;
    if (!body.current.contains(sel.anchorNode)) return;
    const row = (sel.anchorNode.parentElement as HTMLElement | null)?.closest("[data-line]");
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    setDrafting({ quote: quote.length > 400 ? `${quote.slice(0, 400)}…` : quote, line: Number(row?.getAttribute("data-line") ?? 0), x: rect.left + rect.width / 2, y: rect.bottom });
  };

  const copy = () => {
    if (text) navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  /* The states a file can be in that are not "here it is". */
  if (live && remote.isPending) return <Plain path={path}>Reading it off the worker…</Plain>;
  if (live && remote.error) return <Plain path={path}>{why(remote.error)}</Plain>;
  if (live && remote.data?.kind === "binary") return <Plain path={path}>A binary file, {size(remote.data.bytes)}. Nothing to draw.</Plain>;
  if (live && remote.data?.kind === "huge") return <Plain path={path}>{size(remote.data.bytes)} — too much to put on a screen.</Plain>;
  if (!live && !fixture) return <Plain path={path}>Not in the fixtures. The real client reads it off the worker.</Plain>;

  const md = isMarkdown(path);

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-ground">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        <span className="min-w-0 flex-1 truncate font-mono text-meta text-slate" title={path}>{path}</span>
        <span className="shrink-0 font-mono text-micro text-mute">
          {lines.length} lines
          {touched.size > 0 ? <span className="ml-2 text-sage">{touched.size} added here</span> : mine ? <span className="ml-2 text-sage">changed in this session</span> : null}
        </span>
        {md && (
          <button onClick={() => setRendered(!rendered)} className="control h-6 text-micro text-mute hover:bg-raise hover:text-bone">{rendered ? "source" : "rendered"}</button>
        )}
        <button onClick={copy} title="Copy the file" className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-mute transition-colors hover:bg-raise hover:text-bone">
          {copied ? <Check className="h-3.5 w-3.5 text-sage" strokeWidth={2} /> : <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />}
        </button>
      </header>

      <div ref={body} onMouseUp={takeSelection} className="scroll-slim min-h-0 flex-1 overflow-auto py-2">
        {md && rendered ? (
          <div className="prose-desk mx-auto max-w-[46rem] px-8 py-4"><Markdown>{text ?? ""}</Markdown></div>
        ) : (
          <table className="w-max min-w-full border-separate border-spacing-0 font-mono text-code">
            <tbody>
              {lines.map((line, i) => {
                const n = i + 1;
                const hot = touched.has(n);
                const noted = notes.filter((x) => x.line === n);
                return (
                  <tr key={n} data-line={n}>
                    <td className={`sticky left-0 w-12 min-w-12 border-r px-2 text-right align-top tabular-nums select-none ${hot ? "border-sage-deep bg-sage-tint text-sage" : "border-line-soft bg-ground text-mute"}`}>
                      {noted.length > 0 ? <button onClick={() => setReading(noted[0])} title={noted.map((x) => x.text).join("\n")} className="text-slate hover:text-bone">●</button> : n}
                    </td>
                    <td className={`px-3 whitespace-pre ${hot ? "bg-sage-tint/25" : ""}`}>
                      {line === "" ? " " : highlight(line, lang).map((p, k) => <span key={k} className={TONE[p.kind]}>{p.text}</span>)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {drafting && (
        <Annotate at={drafting} onCancel={() => setDrafting(null)} onKeep={(t) => { setNotes((h) => [...h, { id: Date.now(), quote: drafting.quote, line: drafting.line, text: t }]); setDrafting(null); window.getSelection()?.removeAllRanges(); }} />
      )}

      {notes.length > 0 && !drafting && (
        <div className="pointer-events-none absolute right-5 bottom-5 z-30 flex justify-end">
          <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-line bg-overlay py-1.5 pr-1.5 pl-3.5 shadow-(--shadow-float)">
            <span className="text-ui text-dim">{notes.length} note{notes.length > 1 ? "s" : ""}</span>
            <button onClick={() => setNotes([])} title="Discard them" className="grid h-6 w-6 place-items-center rounded-full text-mute transition-colors hover:bg-raise hover:text-bone"><X className="h-3.5 w-3.5" strokeWidth={2} /></button>
            <button disabled={!live || send.isPending} onClick={() => send.mutate()} className="control rounded-full bg-bone font-medium text-ground transition-opacity hover:opacity-90 disabled:bg-raise disabled:text-mute">
              <Send className="h-3.5 w-3.5" strokeWidth={2} />{send.isPending ? "Sending…" : "Send to the agent"}
            </button>
          </div>
        </div>
      )}

      {reading && <Annotate at={{ ...reading, x: window.innerWidth / 2, y: 160 }} onCancel={() => setReading(null)} onKeep={(t) => { setNotes((h) => h.map((x) => (x.id === reading.id ? { ...x, text: t } : x))); setReading(null); }} />}
    </div>
  );
}

function Plain({ path, children }: { path: string; children: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center bg-ground">
      <div className="max-w-[24rem] text-center">
        <p className="font-mono text-ui text-dim">{path}</p>
        <p className="mt-2 text-meta text-mute">{children}</p>
      </div>
    </div>
  );
}

const size = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);
