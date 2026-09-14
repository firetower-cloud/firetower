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
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, FileCode2, FileDiff, FolderTree, MessageSquarePlus, PanelRightClose, Ship as ShipIcon } from "lucide-react";
import { useListFiles } from "~/api/generated/sessions/sessions";
import type { FileEntry, Session } from "~/api/generated/model";
import { sendTurn } from "~/api/generated/sessions/sessions";
import { asMessage } from "~/api/notes";
import { useDiff } from "~/data";
import { fromPatch, isNew } from "~/patch";
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
  const diff = useDiff(session);
  const pending = useDiff(session, "Head");
  const files: Changed[] = useMemo(
    () => diff.data.map((d) => ({ path: d.path, at: d.at, added: d.added, removed: d.removed, lines: fromPatch(d.patch), fresh: isNew(d.patch) })),
    [diff.data],
  );
  /* The tree marks what is not committed yet — the editor's sense of "changed". */
  const changed = useMemo(() => new Map(pending.data.map((d) => [d.at, isNew(d.patch)])), [pending.data]);

  return (
    <aside style={{ width: width ?? 368 }} className="flex shrink-0 flex-col border-l border-line bg-panel">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line px-2">
        <div className="track">
          {TABS.map((t) => (
            <button key={t.id} data-on={tab === t.id} onClick={() => onTab(t.id)}>
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

      <div className="scroll-slim min-h-0 flex-1 overflow-y-auto">
        {tab === "diff" && <DiffList session={session} files={files} loading={diff.loading} error={diff.error} onOpenFile={onOpenFile} />}
        {tab === "files" && <LiveTree sessionId={session.id} changed={changed} onOpenFile={onOpenFile} />}
        {tab === "ship" && <Ship session={session} branch={branch} files={files} />}
      </div>
    </aside>
  );
}

/* ── Diff ──────────────────────────────────────────────────────────────── */

/** `path` as the server names it (what the ship flow sends back); `at` where the file sits in the workspace tree. */
export type Changed = { path: string; at: string; added: number; removed: number; lines: [string, string][]; fresh?: boolean };

function DiffList({
  session,
  files,
  loading,
  error,
  onOpenFile,
}: {
  session: Session;
  files: Changed[];
  loading: boolean;
  error: string | null;
  onOpenFile: (p: string, keep?: boolean) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState<{ id: string; path: string; quote: string; text: string } | null>(null);

  const send = useMutation({
    mutationFn: (n: { id: string; path: string; quote: string; text: string }) =>
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
              <div className="scroll-slim overflow-x-auto border-y border-line-soft bg-ground/50 font-mono text-code">
                {d.lines.map(([kind, text], i) => {
                  const id = `${d.path}:${i}`;
                  return (
                    <div key={i} className="group/line">
                      <div className={`flex w-max min-w-full items-start gap-2 px-3 py-px ${kind === "add" ? "bg-sage-tint text-sage" : kind === "del" ? "bg-brick-tint text-brick" : kind === "hunk" ? "text-slate" : "text-dim"}`}>
                        <span className="w-3 shrink-0 select-none opacity-60">{kind === "add" ? "+" : kind === "del" ? "−" : " "}</span>
                        <span className="flex-1 whitespace-pre">{text}</span>
                        {kind !== "hunk" && (
                          <button onClick={() => setNote(note?.id === id ? null : { id, path: d.path, quote: text, text: "" })} title="Ask for a change here" className="shrink-0 text-mute opacity-0 transition-opacity group-hover/line:opacity-100 hover:text-bone">
                            <MessageSquarePlus className="h-3.5 w-3.5" strokeWidth={1.75} />
                          </button>
                        )}
                      </div>
                      {note?.id === id && (
                        <div className="border-y border-line bg-panel px-3 py-2.5">
                          <input autoFocus value={note.text} onChange={(e) => setNote({ ...note, text: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter" && note.text.trim()) send.mutate(note); if (e.key === "Escape") setNote(null); }} placeholder="What should change here?" className="w-full bg-transparent font-sans text-ui text-bone placeholder:text-mute focus:outline-none" />
                          <div className="mt-2 flex items-center gap-1.5">
                            <button disabled={!note.text.trim() || send.isPending} onClick={() => send.mutate(note)} className="control bg-raise text-ui text-bone hover:bg-overlay disabled:text-mute">{send.isPending ? "Sending…" : "Send to the agent"}</button>
                            <button onClick={() => setNote(null)} className="control text-mute hover:text-dim">Cancel</button>
                            {send.error && <span className="text-meta text-brick">{why(send.error)}</span>}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
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
