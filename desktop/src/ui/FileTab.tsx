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
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Bot, Check, Copy, Send, X } from "lucide-react";
import { Markdown } from "~/components/Markdown";
import { isMarkdown, useFileText } from "~/api/text";
import { sendTurn } from "~/api/generated/sessions/sessions";
import type { Session } from "~/api/generated/model";
import { highlight, langOf, TONE } from "~/syntax";
import { Annotate, type Anchor } from "~/ui/Annotate";
import { addedLines, removedLines } from "~/patch";
import { useDiff } from "~/data";
import { AddAgent } from "~/ui/AddAgent";

type Note = { id: number; quote: string; line: number; text: string };

import { why } from "~/data";

export function FileTab({ session, path, line }: { session: Session; path: string; line?: number }) {
  const sessionId = session.id;
  const diff = useDiff(session, "Head");
  const mine = useMemo(() => diff.data.find((d) => d.at === path), [diff.data, path]);
  const remote = useFileText(sessionId, path);

  const text = remote.data?.kind === "text" ? remote.data.text : null;
  const lines = useMemo(() => (text ? text.replace(/\n$/, "").split("\n") : []), [text]);
  /* The lines this session added, so the file shows its own edits. */
  const touched = useMemo(() => {
    const from = mine ? [...addedLines(mine.patch)] : [];
    return new Set(from.filter((n) => n >= 1 && n <= lines.length));
  }, [mine, lines.length]);
  /* And what those edits replaced, drawn where it was — the file reads like
     the diff does, rather than only showing what survived. */
  const gone = useMemo(() => (mine ? removedLines(mine.patch) : new Map<number, string[]>()), [mine]);
  const goneCount = useMemo(() => [...gone.values()].reduce((n, g) => n + g.length, 0), [gone]);
  const lang = langOf(path);

  const [notes, setNotes] = useState<Note[]>([]);
  const [drafting, setDrafting] = useState<Anchor | null>(null);
  const [reading, setReading] = useState<Note | null>(null);
  const [copied, setCopied] = useState(false);
  const [handing, setHanding] = useState(false);
  const message = () => `On \`${path}\`:\n\n${notes.map((n, i) => `${i + 1}. Line ${n.line}:\n> ${n.quote.split("\n").join("\n> ")}\n\n${n.text}`).join("\n\n")}`;
  /* Markdown reads rendered — unless you came for a line, which only the source has. */
  const [rendered, setRendered] = useState(!line);
  const body = useRef<HTMLDivElement>(null);

  /* Opened at a line — from a path in the conversation or the shell — the
     row is scrolled to the middle and lit for a moment, so the eye lands. */
  const [lit, setLit] = useState<number | null>(null);
  useEffect(() => {
    if (!line || lines.length === 0) return;
    setRendered(false);
    const row = body.current?.querySelector<HTMLElement>(`tr[data-line="${line}"]`);
    row?.scrollIntoView({ block: "center" });
    setLit(line);
    const t = setTimeout(() => setLit(null), 1600);
    return () => clearTimeout(t);
  }, [line, lines.length]);

  const send = useMutation({
    mutationFn: () =>
      sendTurn(sessionId, { text: message(), images: [] }),
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
  if (remote.isPending) return <Plain path={path}>Reading it off the worker…</Plain>;
  if (remote.error) return <Plain path={path}>{why(remote.error)}</Plain>;
  if (remote.data?.kind === "binary") return <Plain path={path}>A binary file, {size(remote.data.bytes)}. Nothing to draw.</Plain>;
  if (remote.data?.kind === "huge") return <Plain path={path}>{size(remote.data.bytes)} — too much to put on a screen.</Plain>;

  const md = isMarkdown(path);

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-ground">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        <span className="min-w-0 flex-1 truncate font-mono text-meta text-slate" title={path}>{path}</span>
        <span className="shrink-0 font-mono text-micro text-mute">
          {lines.length} lines
          {touched.size > 0 && <span className="ml-2 text-sage">+{touched.size}</span>}
          {goneCount > 0 && <span className="ml-1.5 text-brick">−{goneCount}</span>}
          {touched.size === 0 && goneCount === 0 && mine ? <span className="ml-2 text-sage">changed in this session</span> : null}
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
                  <Fragment key={n}>
                  <Removed lines={gone.get(n)} lang={lang} at={n} />
                  <tr data-line={n}>
                    <td className={`sticky left-0 w-12 min-w-12 border-r px-2 text-right align-top tabular-nums select-none ${hot ? "border-sage-deep bg-sage-tint text-sage" : "border-line-soft bg-ground text-mute"}`}>
                      {noted.length > 0 ? <button onClick={() => setReading(noted[0])} title={noted.map((x) => x.text).join("\n")} className="text-slate hover:text-bone">●</button> : n}
                    </td>
                    <td className={`px-3 whitespace-pre transition-colors duration-700 ${lit === n ? "bg-ember-tint" : hot ? "bg-sage-tint/25" : ""}`}>
                      {line === "" ? " " : highlight(line, lang).map((p, k) => <span key={k} className={TONE[p.kind]}>{p.text}</span>)}
                    </td>
                  </tr>
                  </Fragment>
                );
              })}
              <Removed lines={gone.get(lines.length + 1)} lang={lang} at={lines.length + 1} />
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
            <button onClick={() => setHanding(true)} title="Start another agent in this workspace, on these notes" className="control rounded-full text-dim hover:bg-raise hover:text-bone disabled:text-mute">
              <Bot className="h-3.5 w-3.5" strokeWidth={1.75} />Another agent…
            </button>
            <button disabled={send.isPending} onClick={() => send.mutate()} className="control rounded-full bg-bone font-medium text-ground transition-opacity hover:opacity-90 disabled:bg-raise disabled:text-mute">
              <Send className="h-3.5 w-3.5" strokeWidth={2} />{send.isPending ? "Sending…" : "Send to the agent"}
            </button>
          </div>
        </div>
      )}
      {handing && <AddAgent session={session} workspaceId={session.workspaceId ?? session.id} prompt={message()} onClose={() => setHanding(false)} onStarted={() => setNotes([])} />}

      {reading && <Annotate at={{ ...reading, x: window.innerWidth / 2, y: 160 }} onCancel={() => setReading(null)} onKeep={(t) => { setNotes((h) => h.map((x) => (x.id === reading.id ? { ...x, text: t } : x))); setReading(null); }} />}
    </div>
  );
}

/** Lines the session took out, where they were. No number: they are not in the file any more. */
function Removed({ lines, lang, at }: { lines?: string[]; lang: string; at: number }) {
  if (!lines || lines.length === 0) return null;
  return (
    <>
      {lines.map((line, i) => (
        <tr key={`${at}-${i}`} className="select-none">
          <td className="sticky left-0 w-12 min-w-12 border-r border-brick-deep bg-brick-tint px-2 text-right align-top text-brick">−</td>
          <td className="bg-brick-tint/40 px-3 whitespace-pre">
            {line === "" ? " " : highlight(line, lang).map((p, k) => <span key={k} className={TONE[p.kind]}>{p.text}</span>)}
          </td>
        </tr>
      ))}
    </>
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
