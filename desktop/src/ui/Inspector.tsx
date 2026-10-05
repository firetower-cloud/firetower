/**
 * The right rail: what changed, what's in there, and shipping it.
 *
 * Three tabs rather than three panes, because they are three answers to the
 * same question — what has this agent actually done to my repository — and you
 * want one of them at a time while you read the conversation beside it.
 *
 * On a connected server every tab reads the worker: the tree one directory at
 * a time off `list_files`, the diff off `session_diff`, the commit off
 * `session_work`.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, FileCode2, FileDiff, FolderTree, MessageSquarePlus, PanelRightClose, Ship as ShipIcon } from "lucide-react";
import { useListFiles } from "~/api/generated/sessions/sessions";
import type { FileEntry, Session } from "~/api/generated/model";
import { sendTurn } from "~/api/generated/sessions/sessions";
import { asMessage } from "~/api/notes";
import { useDiff } from "~/data";
import { fromPatch } from "~/patch";
import { why } from "~/data";
import { Ship } from "~/ui/Ship";
import { FileGlyph } from "~/ui/FileGlyph";

const TABS = [
  { id: "diff", label: "Diff", icon: FileDiff },
  { id: "files", label: "Files", icon: FolderTree },
  { id: "ship", label: "Commit", icon: ShipIcon },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function Inspector({
  session,
  workspace,
  branch,
  tab,
  onTab,
  onOpenFile,
  onClose,
  width,
}: {
  session: Session;
  workspace: string;
  branch?: string;
  tab: TabId;
  onTab: (t: TabId) => void;
  onOpenFile: (path: string, keep?: boolean) => void;
  onClose: () => void;
  width?: number;
}) {
  /* Committing, pushing a branch and opening a pull request all go out under
     the *session owner's* git identity, so they are the owner's and not the
     workspace's — `maySpeak`, not `mayWrite`. Somebody with writer here has
     their own agent to push from. The diff and the file tree are what watching
     the work means; this tab is not part of it. */
  const mayAct = session.maySpeak !== false;
  const tabs = useMemo(() => (mayAct ? TABS : TABS.filter((t) => t.id !== "ship")), [mayAct]);
  /* A tab is remembered across sessions, so somebody who was last on Commit in
     their own workspace must not open somebody else's to an empty panel. */
  const shown: TabId = tab === "ship" && !mayAct ? "diff" : tab;

  const diff = useDiff(session);
  /* Names only: the tree marks each file added or modified and reads nothing
     else, and this was pulling every byte of every patch to do it. */
  const pending = useDiff(session, "Head", true);
  /* The patch is carried, not read. Turning one into rows costs about what it
     is long, and only the open file's rows are drawn — so `Hunks` does it for
     that one file and nothing does it for the other forty. */
  const files: Changed[] = useMemo(
    () => diff.data.map((d) => ({ path: d.path, at: d.at, added: d.added, removed: d.removed, patch: d.patch, fresh: d.fresh, truncated: d.truncated })),
    [diff.data],
  );
  /* The tree marks what is not committed yet — the editor's sense of "changed". */
  const changed = useMemo(() => new Map(pending.data.map((d) => [d.at, d.fresh === true])), [pending.data]);
  /* The pane that scrolls. The diff draws only the rows in it, so the list
     inside has to be able to ask where it has got to. */
  const scroller = useRef<HTMLDivElement>(null);

  return (
    <aside style={{ width: width ?? 368 }} className="flex shrink-0 flex-col border-l border-line bg-panel">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line px-2">
        <div className="track">
          {tabs.map((t) => (
            <button key={t.id} data-on={shown === t.id} onClick={() => onTab(t.id)}>
              <span className="flex items-center gap-1.5">
                <t.icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                {t.label}
                {t.id === "diff" && files.length > 0 && <span className="font-mono text-micro opacity-60">{files.length}</span>}
              </span>
            </button>
          ))}
        </div>
        <button onClick={onClose} title="Hide the inspector" className="ml-auto grid h-7 w-7 place-items-center rounded-md text-mute transition-colors hover:bg-raise hover:text-bone">
          <PanelRightClose className="h-4 w-4" strokeWidth={1.75} />
        </button>
      </div>

      <div ref={scroller} className="scroll-slim min-h-0 flex-1 overflow-y-auto">
        {shown === "diff" && <DiffList session={session} files={files} loading={diff.loading} error={diff.error} onOpenFile={onOpenFile} scroller={scroller} />}
        {shown === "files" && <LiveTree sessionId={session.id} changed={changed} onOpenFile={onOpenFile} />}
        {shown === "ship" && <Ship session={session} branch={branch} files={files} />}
      </div>
    </aside>
  );
}

/* ── Diff ──────────────────────────────────────────────────────────────── */

/** `path` as the server names it (what the ship flow sends back); `at` where the file sits in the workspace tree. */
export type Changed = { path: string; at: string; added: number; removed: number; patch: string; fresh?: boolean; truncated?: boolean };

/** A note being written against one line of one file. */
type Note = { id: string; path: string; quote: string; text: string };

function DiffList({
  session,
  files,
  loading,
  error,
  onOpenFile,
  scroller,
}: {
  session: Session;
  files: Changed[];
  loading: boolean;
  error: string | null;
  onOpenFile: (p: string, keep?: boolean) => void;
  scroller: React.RefObject<HTMLDivElement | null>;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState<Note | null>(null);

  const send = useMutation({
    mutationFn: (n: Note) =>
      sendTurn(session.id, {
        text: `On \`${n.path}\`:\n\n${asMessage([{ id: n.id, item: n.path, quote: n.quote, note: n.text } as never])}`,
        images: [],
      }),
    onSuccess: () => setNote(null),
  });

  if (loading) return <Empty line="Reading the diff…" hint="" />;
  if (error) return <Empty line={error} hint="" />;
  if (files.length === 0) return <Empty line="Nothing changed yet." hint="Edits the agent makes will show up here." />;

  const first = open ?? files[0].path;

  return (
    <div className="py-1">
      {files.map((d) => {
        const on = first === d.path;
        return (
          <div key={d.path}>
            <button onClick={() => setOpen(on ? "" : d.path)} className="group/file flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-raise/60">
              <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-mute transition-transform duration-150 ${on ? "rotate-90" : ""}`} strokeWidth={1.75} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 truncate font-mono text-ui text-bone"><FileGlyph name={d.path.split("/").pop() ?? d.path} />{d.path.split("/").pop()}</span>
                <span className="block truncate font-mono text-micro text-mute">{d.path.split("/").slice(0, -1).join("/")}</span>
              </span>
              <span className="shrink-0 font-mono text-micro"><span className="text-sage">+{d.added}</span> <span className="text-brick">−{d.removed}</span></span>
              <span role="button" tabIndex={0} title="Open the whole file" onClick={(e) => { e.stopPropagation(); onOpenFile(d.at, true); }} className="grid h-5 w-5 shrink-0 place-items-center rounded text-mute opacity-0 transition-opacity group-hover/file:opacity-100 hover:bg-overlay hover:text-bone">
                <FileCode2 className="h-3.5 w-3.5" strokeWidth={1.75} />
              </span>
            </button>

            {on && (
              <Hunks
                path={d.path}
                patch={d.patch}
                truncated={d.truncated === true}
                at={d.at}
                onOpenFile={onOpenFile}
                scroller={scroller}
                note={note?.path === d.path ? note : null}
                onNote={setNote}
                onSend={(n) => send.mutate(n)}
                sending={send.isPending}
                failure={send.error ? why(send.error) : null}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A row's height, in pixels, fixed rather than measured.
 *
 * Every row is one line of `whitespace-pre` that never wraps, so they are all
 * the same height anyway — saying so in one number means the window is
 * arithmetic, with no per-row measuring and no drift between what the spacers
 * reserve and what the rows take. 21px of line box inside 1px of padding
 * either side, which is what `text-code` was drawing before.
 */
const ROW = 23;

/** Rows drawn beyond the pane, above and below. */
const OVERSCAN = 24;

/**
 * One file's hunks, drawing only the rows the pane can show.
 *
 * A day's work on one file is thousands of lines, and drawing all of them was
 * what made this pane expensive: a hundred and twenty thousand nodes, a hundred
 * and seventy megabytes, and a third of a second of frozen main thread every
 * time the poll came back while the agent was still editing — which is exactly
 * when you have this open. Rows above and below the pane are two spacer divs.
 *
 * The note card is in the flow, so the rows below it are pushed down by about a
 * card's height and the arithmetic is that much wrong for them. `OVERSCAN` is
 * far more than a card is tall, so the error never reaches an edge.
 */
function Hunks({
  path,
  patch,
  truncated,
  at,
  onOpenFile,
  scroller,
  note,
  onNote,
  onSend,
  sending,
  failure,
}: {
  path: string;
  patch: string;
  /** The server cut this one for length; what is here is the start of it. */
  truncated: boolean;
  at: string;
  onOpenFile: (p: string, keep?: boolean) => void;
  scroller: React.RefObject<HTMLDivElement | null>;
  note: Note | null;
  onNote: (n: Note | null) => void;
  onSend: (n: Note) => void;
  sending: boolean;
  failure: string | null;
}) {
  /* Read here, for this file only. The sheet carries patches; this is the one
     place that turns one into rows. */
  const lines = useMemo(() => fromPatch(patch), [patch]);
  /* Held so the pane does not change width as the window moves over it: the
     widest line decides how far the diff scrolls sideways, and with only some
     of the rows drawn that would otherwise be the widest line *in view*. Each
     character is one `ch` in a monospace face; the rest is the row's gutter. */
  const widest = useMemo(() => lines.reduce((n, [, text]) => Math.max(n, text.length), 0), [lines]);

  const box = useRef<HTMLDivElement>(null);
  const [[from, to], setSeen] = useState<[number, number]>([0, OVERSCAN * 2]);
  /* One control for the pane rather than one per row. Drawn into whichever row
     the pointer is over, which is where it has always appeared — the thirteen
     thousand that were in the document waiting to be hovered were more than
     half of everything in it. */
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const pane = scroller.current;
    const node = box.current;
    if (!pane || !node) return;
    const fit = () => {
      /* How much of this block is above the top of the pane. Measured against
         the pane rather than from `scrollTop`, so the file rows and the other
         files' headers above it do not have to be accounted for. */
      const above = Math.max(0, pane.getBoundingClientRect().top - node.getBoundingClientRect().top);
      const first = Math.max(0, Math.floor(above / ROW) - OVERSCAN);
      const last = Math.min(lines.length, Math.ceil((above + pane.clientHeight) / ROW) + OVERSCAN);
      setSeen((held) => (held[0] === first && held[1] === last ? held : [first, last]));
    };
    fit();
    pane.addEventListener("scroll", fit, { passive: true });
    /* The pane is resizable by its edge, and the window it is in resizes. */
    const watch = new ResizeObserver(fit);
    watch.observe(pane);
    return () => {
      pane.removeEventListener("scroll", fit);
      watch.disconnect();
    };
  }, [scroller, lines.length]);

  return (
    <>
      <div
        ref={box}
        onMouseOver={(e) => {
          const row = (e.target as HTMLElement).closest<HTMLElement>("[data-row]");
          setHover(row ? Number(row.dataset.row) : null);
        }}
        onMouseLeave={() => setHover(null)}
        /* `contain-layout` so that measuring something else on the page — the
           composer sizing itself to its text on every keystroke — cannot be
           made to lay these rows out again. */
        className="scroll-slim contain-layout overflow-x-auto border-y border-line-soft bg-ground/50 font-mono text-code"
      >
      <div style={{ minWidth: `calc(${widest}ch + 3.5rem)` }}>
        <div style={{ height: from * ROW }} aria-hidden />
        {lines.slice(from, to).map(([kind, text], nth) => {
          const i = from + nth;
          const id = `${path}:${i}`;
          return (
            <div key={i}>
              <div
                data-row={i}
                style={{ height: ROW }}
                className={`flex items-start gap-2 px-3 py-px ${kind === "add" ? "bg-sage-tint text-sage" : kind === "del" ? "bg-brick-tint text-brick" : kind === "hunk" ? "text-slate" : "text-dim"}`}
              >
                <span className="w-3 shrink-0 select-none opacity-60">{kind === "add" ? "+" : kind === "del" ? "−" : " "}</span>
                <span className="flex-1 whitespace-pre">{text}</span>
                {kind !== "hunk" && hover === i && (
                  <button onClick={() => onNote(note?.id === id ? null : { id, path, quote: text, text: "" })} title="Ask for a change here" className="shrink-0 text-mute hover:text-bone">
                    <MessageSquarePlus className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </button>
                )}
              </div>
              {note?.id === id && (
                <div className="border-y border-line bg-panel px-3 py-2.5">
                  <input autoFocus value={note.text} onChange={(e) => onNote({ ...note, text: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter" && note.text.trim()) onSend(note); if (e.key === "Escape") onNote(null); }} placeholder="What should change here?" className="w-full bg-transparent font-sans text-ui text-bone placeholder:text-mute focus:outline-none" />
                  <div className="mt-2 flex items-center gap-1.5">
                    <button disabled={!note.text.trim() || sending} onClick={() => onSend(note)} className="control bg-raise text-ui text-bone hover:bg-overlay disabled:text-mute">{sending ? "Sending…" : "Send to the agent"}</button>
                    <button onClick={() => onNote(null)} className="control text-mute hover:text-dim">Cancel</button>
                    {failure && <span className="text-meta text-brick">{failure}</span>}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        <div style={{ height: Math.max(0, lines.length - to) * ROW }} aria-hidden />
      </div>
      </div>

      {/* Said at the foot, where the patch stops, rather than as a banner at
          the top: what is above is real and worth reading, and the only thing
          wrong with it is that it is not all of it.

          Outside the scrolling box on purpose — inside, it would be as wide as
          the widest line of code and the way out of it would be somewhere off
          to the right. */}
      {truncated && (
        <div className="flex items-center gap-2 border-b border-line-soft bg-panel px-3 py-2.5">
          <span className="min-w-0 flex-1 text-meta text-mute">Too much changed here to draw it all.</span>
          <button onClick={() => onOpenFile(at, true)} className="control shrink-0 text-ui text-dim hover:bg-raise hover:text-bone">
            Open the file
          </button>
        </div>
      )}
    </>
  );
}

/* ── Files, off the worker ─────────────────────────────────────────────── */

function LiveTree({ sessionId, changed, onOpenFile }: { sessionId: string; changed: Map<string, boolean>; onOpenFile: (p: string, keep?: boolean) => void }) {
  const cache = useQueryClient();
  /* A directory carries the mark of anything changed inside it, so a folded
     tree still says where the work is. */
  const marked = useMemo(() => {
    const dirs = new Set<string>();
    for (const path of changed.keys()) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
    return dirs;
  }, [changed]);
  /* A file the agent just created is not in any listing already read, so the
     set of changed paths moving is the cue to read the tree again. */
  const key = useMemo(() => [...changed.keys()].sort().join("\n"), [changed]);
  useEffect(() => {
    if (key) cache.invalidateQueries({ queryKey: [`/api/v1/sessions/${sessionId}/files`] });
  }, [key, sessionId, cache]);
  return (
    <div className="py-1.5">
      <Directory sessionId={sessionId} path="" depth={0} changed={changed} marked={marked} onOpenFile={onOpenFile} />
    </div>
  );
}

function Directory({ sessionId, path, depth, changed, marked, onOpenFile }: { sessionId: string; path: string; depth: number; changed: Map<string, boolean>; marked: Set<string>; onOpenFile: (p: string, keep?: boolean) => void }) {
  const { data, isPending, error } = useListFiles(sessionId, { path }, { query: { staleTime: 30_000 } });
  const entries = useMemo(
    () => [...((data ?? []) as FileEntry[])].sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)),
    [data],
  );
  if (isPending) return <p className="px-3 py-1 text-meta text-mute" style={{ paddingLeft: `${0.75 + depth * 0.85}rem` }}>…</p>;
  if (error) return <p className="px-3 py-1 text-meta text-brick">{why(error)}</p>;
  if (entries.length === 0 && depth === 0) return <Empty line="An empty workspace." hint="Nothing is checked out here yet." />;
  return (
    <>
      {entries.map((e) => (
        <Entry key={e.name} sessionId={sessionId} entry={e} path={path ? `${path}/${e.name}` : e.name} depth={depth} changed={changed} marked={marked} onOpenFile={onOpenFile} />
      ))}
    </>
  );
}

function Entry({ sessionId, entry, path, depth, changed, marked, onOpenFile }: { sessionId: string; entry: FileEntry; path: string; depth: number; changed: Map<string, boolean>; marked: Set<string>; onOpenFile: (p: string, keep?: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const touched = entry.directory ? marked.has(path) : changed.has(path);
  const fresh = !entry.directory && changed.get(path) === true;
  return (
    <>
      <button
        onClick={() => (entry.directory ? setOpen(!open) : onOpenFile(path))}
        onDoubleClick={() => !entry.directory && onOpenFile(path, true)}
        style={{ paddingLeft: `${0.75 + depth * 0.85}rem` }}
        className="flex h-7 w-full items-center gap-1.5 pr-3 text-left transition-colors hover:bg-raise/60"
      >
        {entry.directory ? <ChevronRight className={`h-3 w-3 shrink-0 text-mute transition-transform duration-150 ${open ? "rotate-90" : ""}`} strokeWidth={2} /> : <span className="w-3 shrink-0" />}
        <FileGlyph name={entry.name} directory={entry.directory} open={open} tone={touched && !entry.directory ? "text-sage" : undefined} />
        <span className={`min-w-0 flex-1 truncate font-mono text-ui ${entry.directory ? "text-dim" : touched ? "text-sage" : "text-text"}`}>{entry.name}{entry.link ? " →" : ""}</span>
        {touched && <span className={`shrink-0 font-mono text-micro ${entry.directory ? "text-mute" : "text-sage"}`}>{entry.directory ? "•" : fresh ? "A" : "M"}</span>}
      </button>
      {entry.directory && open && <Directory sessionId={sessionId} path={path} depth={depth + 1} changed={changed} marked={marked} onOpenFile={onOpenFile} />}
    </>
  );
}

function Empty({ line, hint }: { line: string; hint: string }) {
  return (
    <div className="px-6 py-10 text-center">
      <p className="text-ui text-dim">{line}</p>
      {hint && <p className="mt-1 text-meta text-mute">{hint}</p>}
    </div>
  );
}
