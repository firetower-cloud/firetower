/**
 * The conversation, off the stream.
 *
 * Everything drawn here comes from `useConversation` in
 * `web/src/api/conversation.ts` — the fold from lifecycle events into items,
 * requests, questions, tasks, plan, usage and mode. That fold is the contract;
 * this file only decides how each thing looks at desk size.
 *
 * Two rules taken from the web build rather than re-derived, because both were
 * got wrong here first:
 *
 * - **Runs of scaffolding fold.** `src/api/steps.ts` groups three or more
 *   consecutive commands / reads / searches into one disclosure and never folds
 *   an edit, because an edit is the work. Ten `ran ls` rows are one line.
 * - **Prose is markdown.** The agent writes it; `components/Markdown.tsx`
 *   renders it with raw HTML off, so a session cannot inject markup.
 *
 * The approval card is the one loud thing. The agent is genuinely stopped while
 * it is up — the tool call is held open on the host — and it can sit there for
 * hours; the session picks up where it was.
 */
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronRight,
  Copy,
  FileText,
  FileUp,
  GitBranch,
  Pencil,
  RotateCcw,
  Search,
  Send,
  Terminal,
  Users,
  X,
} from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Icon } from "~/components/ui";
import { Markdown } from "~/components/Markdown";
import { editFrom } from "~/components/EditCard";
import { stepLines } from "~/components/Steps";
import { useConversation, type Asked, type Item, type Questionnaire, type Task } from "~/api/conversation";
import { fold, summarise } from "~/api/steps";
import type { Decision, Event, ItemKind, PlanStep, RequestKind, Session } from "~/api/generated/model";
import { useAnswerRequest, useRelaunchSession, getGetSessionQueryKey, sendTurn } from "~/api/generated/sessions/sessions";
import { asMessage, useNotes, type Note } from "~/api/notes";
import { useListEvents } from "~/api/generated/events/events";
import { elapsed, minutesSince } from "~/api/view";
import { Composer, TAKES, type Hand } from "~/ui/Composer";
import { folderRefusals, useFileDrop } from "~/ui/drop";
import { AccountSwitcher } from "~/ui/AccountSwitcher";
import { Annotate, type Anchor } from "~/ui/Annotate";
import { markPaths, resolvePath } from "~/paths";
import { ImagesFrom } from "~/components/WorkspaceImage";
import { AddAgent } from "~/ui/AddAgent";

const DID: Partial<Record<ItemKind, string>> = {
  CommandExecution: "ran",
  FileChange: "changed",
  FileRead: "read",
  McpToolCall: "called",
  WebSearch: "searched",
  SubagentCall: "sent",
};

const GLYPH: Partial<Record<ItemKind, typeof Terminal>> = {
  CommandExecution: Terminal,
  FileRead: FileText,
  FileChange: Pencil,
  WebSearch: Search,
  SubagentCall: Users,
};

const ASKING: Record<RequestKind, string> = {
  CommandExecution: "wants to run",
  FileChange: "wants to change",
  FileRead: "wants to read",
  Tool: "wants to use",
};

/** The one line of a tool call worth reading. */
function said(item: Item): string {
  const input = item.input as Record<string, unknown> | undefined;
  for (const key of ["command", "file_path", "path", "pattern", "query", "description", "url"]) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return item.title ?? "…";
}

/** The part of a request worth reading before deciding. */
function what(asked: Asked): string {
  const args = asked.args as Record<string, unknown> | undefined;
  for (const key of ["command", "file_path", "path", "url"]) {
    const value = args?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return JSON.stringify(asked.args ?? {}, null, 2);
}

type Open = { onOpenDiff: () => void; onOpenFile: (path: string, keep?: boolean, line?: number) => void };

export function Chat({
  session,
  branch,
  onOpenDiff,
  onOpenFile,
}: {
  session: Session;
  branch?: string;
} & Open) {
  const { conversation, echo, settle, remember, stopping } = useConversation(session.id);
  const scroller = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  /* Dropped files are the composer's business — it owns the size rules, the
     chips and the refusal line — but the composer is a strip at the bottom and
     the conversation is what a hand aims at. So the whole pane is the target
     and it hands what it caught down. One surface, because `drop` bubbles. */
  const hand = useRef<Hand | null>(null);

  /* Notes on what the agent said — the web's own store, so they survive a
     reload and go out as one ordinary message. */
  const { notes, add, drop, clear } = useNotes(session.id);
  const [drafting, setDrafting] = useState<Anchor & { item: string } | null>(null);
  /* Or to a second agent, started here on the notes. */
  const [handing, setHanding] = useState(false);
  const post = useMutation({
    mutationFn: () => sendTurn(session.id, { text: asMessage(notes), images: [] }),
    onSuccess: () => {
      echo(asMessage(notes));
      clear();
    },
  });
  /* Only what the agent said can be annotated; the selection has to start
     inside one of its turns, marked `data-said`. */
  const takeSelection = (e: React.MouseEvent) => {
    const sel = window.getSelection();
    const quote = sel?.toString().trim();
    if (!quote || quote.length < 2 || !sel?.anchorNode || sel.rangeCount === 0 || !body.current?.contains(sel.anchorNode)) return;
    const said = (sel.anchorNode.parentElement as HTMLElement | null)?.closest<HTMLElement>("[data-said]");
    if (!said) return;
    // Where the drag ended — a turn longer than the window has a selection box
    // whose bottom edge is off the bottom of it. See `FileTab`.
    setDrafting({ quote: quote.length > 400 ? `${quote.slice(0, 400)}…` : quote, line: 0, label: "Note on what the agent said", item: said.dataset.said ?? "", x: e.clientX, y: e.clientY });
  };

  /* The bring-up — Fetch → Worktree → Workspace → Setup → Launch — so a fresh
     workspace is not a blank screen for the forty seconds before the agent
     says anything. Read from this session's events, folded by the web's own
     `stepLines`. */
  const events = useListEvents({ sessionId: session.id } as Parameters<typeof useListEvents>[0]);
  const steps = useMemo(
    () => stepLines(session, (events.data ?? []) as Event[]),
    [session, events.data],
  );

  const { items, asked, questions, working, stopped } = conversation;
  const answerable = session.status !== "Ended";

  /* An ended session has no one to read the file and a workspace that is going
     away, so the pane stops offering. Refusing the drag outright is kinder
     than taking the file and then greying out the send button. */
  const { over, surface } = useFileDrop(
    ({ files, folders }) => hand.current?.(files, folderRefusals(folders)),
    answerable,
  );

  const rows = useMemo(() => fold(items), [items]);

  /* Edits are not on the event stream, only the tool calls that make them
     are. So every finished edit or command is the cue to read the diff, the
     tree and any open file again — before the poll would have. */
  const cache = useQueryClient();
  const settled = useMemo(
    () => items.filter((i) => (i.kind === "FileChange" || i.kind === "CommandExecution") && i.status !== undefined).length,
    [items],
  );
  useEffect(() => {
    if (settled === 0) return;
    const id = session.id;
    void cache.invalidateQueries({ queryKey: [`/api/v1/sessions/${id}/diff`] });
    void cache.invalidateQueries({ queryKey: [`/api/v1/sessions/${id}/files`] });
    void cache.invalidateQueries({ queryKey: ["file-text", id] });
  }, [settled, working, session.id, cache]);

  /* Opens at the end and stays there while the transcript grows — unless you
     scrolled up to read something, in which case it leaves you alone. Growth
     is watched rather than counted: markdown and images settle after the item
     count has stopped changing. */
  useLayoutEffect(() => {
    const el = scroller.current;
    const inner = body.current;
    if (!el || !inner) return;
    const toEnd = () => {
      if (following.current) el.scrollTop = el.scrollHeight;
    };
    toEnd();
    const watch = new ResizeObserver(toEnd);
    watch.observe(inner);
    return () => watch.disconnect();
  }, []);
  /* Resize callbacks need a painted frame; a webview that is not being drawn
     gets none, so the count moving is a second cue for the same thing. */
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [rows.length, working, asked.length, questions.length]);

  /* While the agent is talking, the end is checked every frame. A resize
     observer reports after layout and can trail a fast stream by a few
     frames, which reads as the page lagging behind the words and then
     catching up; a frame-by-frame check costs one comparison and keeps the
     last line pinned. Nothing runs while the agent is idle. */
  useEffect(() => {
    if (!working) return;
    let raf = 0;
    const loop = () => {
      const el = scroller.current;
      if (el && following.current && el.scrollHeight - el.scrollTop - el.clientHeight > 1) el.scrollTop = el.scrollHeight;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [working]);

  return (
    <div className="relative flex h-full min-h-0 flex-col" {...surface}>
      {over && (
        <div className="pointer-events-none absolute inset-2 z-40 grid place-items-center rounded-2xl border border-slate bg-ground/45">
          {/* The limit, not the routing. Where a file ends up is shown for
              real a moment later — the chip names the path it landed at. */}
          <span className="flex items-center gap-2.5 rounded-xl border border-line bg-overlay px-4 py-2.5 shadow-(--shadow-float)">
            <FileUp className="h-4 w-4 text-slate" strokeWidth={1.75} />
            <span>
              <span className="block text-ui text-bone">Drop to attach</span>
              <span className="block text-meta text-mute">{TAKES}</span>
            </span>
          </span>
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onMouseUp={takeSelection}
        className="scroll-slim min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <SessionContext.Provider value={{ session: session.id }}>
        <ImagesFrom.Provider value={{ session: session.id, onOpen: onOpenFile }}>
        <NotesContext.Provider value={{ notes, drop }}>
        <div ref={body} className="mx-auto w-full max-w-[46rem] px-8 pt-8 pb-4">
          <h1 className="text-display text-bone">{session.title}</h1>
          <div className="mt-2 flex items-center gap-4 text-meta text-mute">
            {branch && (
              <span className="flex items-center gap-1.5 font-mono">
                <GitBranch className="h-3.5 w-3.5" strokeWidth={1.75} />
                {branch}
              </span>
            )}
            <span>started {elapsed(minutesSince(session.createdAt))} ago</span>
            {conversation.model && <span className="font-mono">{conversation.model}</span>}
          </div>

          {steps.length > 0 && <BringUp steps={steps} />}

          {conversation.plan.length > 0 && <Plan steps={conversation.plan} />}

          {items.length === 0 && !working && steps.every((s) => s.state === "done") && (
            <p className="mt-10 text-read text-mute">
              {conversation.trouble ?? "Nothing said yet. The agent is here and waiting for you."}
            </p>
          )}

          <ol className="mt-9 space-y-7">
            {rows.map((row) =>
              row.type === "item" ? (
                <Node key={row.item.id} item={row.item} items={items} tasks={conversation.tasks} onOpenDiff={onOpenDiff} onOpenFile={onOpenFile} />
              ) : (
                <Group key={row.id} items={row.items} all={items} tasks={conversation.tasks} onOpenDiff={onOpenDiff} onOpenFile={onOpenFile} />
              ),
            )}
          </ol>

          {working && <Working heardAt={conversation.heardAt} items={items} />}
          {stopped && <Stopped why={stopped} />}
          {session.status === "Failed" && <Relaunch session={session} />}

          {questions.map((q) => (
            <Questions key={q.req} sessionId={session.id} asking={q} onAnswered={() => settle(q.req)} />
          ))}
          {asked.map((a) => (
            <Approval key={a.req} sessionId={session.id} asked={a} onAnswered={() => settle(a.req)} />
          ))}

        </div>
        </NotesContext.Provider>
        </ImagesFrom.Provider>
        </SessionContext.Provider>
      </div>

      {drafting && (
        <Annotate
          at={drafting}
          onCancel={() => setDrafting(null)}
          onKeep={(t) => {
            add(drafting.item, drafting.quote, t);
            setDrafting(null);
            window.getSelection()?.removeAllRanges();
          }}
        />
      )}

      {notes.length > 0 && !drafting && (
        <div className="pointer-events-none absolute right-5 bottom-4 z-30 flex justify-end">
          <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-line bg-overlay py-1.5 pr-1.5 pl-3.5 shadow-(--shadow-float)">
            <span className="text-ui text-dim">{notes.length} note{notes.length > 1 ? "s" : ""}</span>
            <button onClick={clear} title="Discard them" className="grid h-6 w-6 place-items-center rounded-full text-mute transition-colors hover:bg-raise hover:text-bone"><X className="h-3.5 w-3.5" strokeWidth={2} /></button>
            <button onClick={() => setHanding(true)} title="Start another agent in this workspace, on these notes" className="control rounded-full text-dim hover:bg-raise hover:text-bone disabled:text-mute">
              <Bot className="h-3.5 w-3.5" strokeWidth={1.75} />Another agent…
            </button>
            <button disabled={!answerable || post.isPending} onClick={() => post.mutate()} className="control rounded-full bg-bone font-medium text-ground transition-opacity hover:opacity-90 disabled:bg-raise disabled:text-mute">
              <Send className="h-3.5 w-3.5" strokeWidth={2} />{post.isPending ? "Sending…" : "Send to the agent"}
            </button>
          </div>
        </div>
      )}
      {handing && <AddAgent session={session} workspaceId={session.workspaceId ?? session.id} prompt={asMessage(notes)} onClose={() => setHanding(false)} onStarted={clear} />}
      </div>

      <AccountSwitcher session={session} working={working}>
        <Composer
          session={session}
          conversation={conversation}
          onEcho={echo}
          onRemember={remember}
          onStopping={stopping}
          disabled={!answerable}
          asking={asked.length + questions.length > 0}
          hand={hand}
        />
      </AccountSwitcher>
    </div>
  );
}

/* ── Rows ──────────────────────────────────────────────────────────────── */

function Node({
  item,
  items,
  tasks,
  onOpenDiff,
  onOpenFile,
}: { item: Item; items: Item[]; tasks: Task[] } & Open) {
  if (item.kind === "UserMessage") {
    return (
      <li className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md border border-line bg-raise px-4 py-2.5 text-read text-text shadow-(--shadow-raise)">
          {item.images && item.images.length > 0 && (
            <div className={`flex flex-wrap gap-1.5 ${item.text ? "mb-2" : ""}`}>
              {item.images.map((image, i) => (
                <img key={i} src={`data:${image.mediaType};base64,${image.data}`} alt="" className="max-h-[200px] max-w-full rounded-md border border-line object-contain" />
              ))}
            </div>
          )}
          {item.text && <p className="whitespace-pre-wrap">{item.text}</p>}
        </div>
      </li>
    );
  }

  if (item.kind === "AssistantMessage") return <Said item={item} onOpenFile={onOpenFile} />;

  if (item.kind === "Reasoning") return <Thought item={item} />;
  if (item.kind === "Question") return <Answered item={item} />;
  if (item.kind === "SubagentCall") return <Delegated item={item} items={items} tasks={tasks} onOpenDiff={onOpenDiff} onOpenFile={onOpenFile} />;
  if (item.kind === "FileChange" && editFrom(item.input)) return <Edited item={item} onOpenDiff={onOpenDiff} />;

  return <ToolRow item={item} onOpenDiff={onOpenDiff} onOpenFile={onOpenFile} />;
}

/** Which session the turns belong to — for the paths in them. */
const SessionContext = createContext<{ session: string | null }>({ session: null });

/** The notes so far, and how to take one back — read by the turn it is on. */
const NotesContext = createContext<{ notes: Note[]; drop: (id: string) => void }>({ notes: [], drop: () => {} });

/**
 * What the agent said. Selecting any of it starts a note (see `takeSelection`
 * on the scroller); the notes already taken against this turn are drawn under
 * it, so the draft reads in place rather than in a list somewhere else.
 */
function Said({ item, onOpenFile }: { item: Item; onOpenFile: Open["onOpenFile"] }) {
  const { notes, drop } = useContext(NotesContext);
  const mine = notes.filter((n) => n.item === item.id);
  const prose = useRef<HTMLDivElement>(null);
  const { session } = useContext(SessionContext);
  /* After every render, paths in the markdown become clickable — every
     render, because a re-render replaces the DOM the marks were put on, and
     marking is cheap: nodes already marked are skipped. The check that a path
     is real happens on the click, not here — a turn can name a hundred files
     while streaming. */
  useEffect(() => {
    if (prose.current) markPaths(prose.current);
  });
  const [notice, setNotice] = useState<string | null>(null);
  /* The markdown is rebuilt only when the text changes: a re-render of this
     turn for any other reason (a note kept, a notice) keeps the DOM, and with
     it the marks — and the element somebody is about to click. */
  const rendered = useMemo(() => <Markdown>{item.text}</Markdown>, [item.text]);
  const onClick = async (e: React.MouseEvent) => {
    const hit = (e.target as HTMLElement).closest<HTMLElement>("[data-path]");
    if (!hit || !session) return;
    e.preventDefault();
    const real = await resolvePath(session, hit.dataset.path ?? "");
    if (real) onOpenFile(real, true, hit.dataset.line ? Number(hit.dataset.line) : undefined);
    else {
      setNotice(`${hit.dataset.path} is not in this workspace.`);
      setTimeout(() => setNotice(null), 2500);
    }
  };
  return (
    <li className="group/turn">
      <div ref={prose} onClick={onClick} className="prose-desk" data-said={item.id}>
        {rendered}
      </div>
      {notice && <p className="mt-1 text-meta text-mute">{notice}</p>}
      {mine.length > 0 && (
        <ul className="mt-3 space-y-2">
          {mine.map((n) => (
            <li key={n.id} className="flex items-start gap-2.5 rounded-lg border border-line-soft bg-panel/70 px-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate border-l-2 border-slate-deep pl-2 font-mono text-micro text-mute">{n.quote}</span>
                <span className="mt-1 block text-ui text-text">{n.note}</span>
              </span>
              <button onClick={() => drop(n.id)} title="Take it back" className="grid h-6 w-6 shrink-0 place-items-center rounded text-mute hover:bg-raise hover:text-bone"><X className="h-3.5 w-3.5" strokeWidth={2} /></button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex gap-1 opacity-0 transition-opacity duration-150 group-hover/turn:opacity-100">
        <Action icon={Copy} label="Copy" onClick={() => navigator.clipboard?.writeText(item.text)} />
      </div>
    </li>
  );
}

/**
 * A run of scaffolding, folded into one row.
 *
 * Closed by default, including when something inside it failed — the summary
 * carries the count instead, so a broken command is named without the group
 * opening itself under somebody who was reading.
 */
function Group({ items, all, tasks, onOpenDiff, onOpenFile }: { items: Item[]; all: Item[]; tasks: Task[] } & Open) {
  const [open, setOpen] = useState(false);
  const sum = summarise(items);
  return (
    <li className="ml-px border-l border-line pl-4">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left font-mono text-code hover:bg-raise/60">
        <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-mute transition-transform duration-150 ${open ? "rotate-90" : ""}`} strokeWidth={1.75} />
        <span className="text-dim">{sum.verb}</span>
        <span className="min-w-0 flex-1 truncate text-mute">{sum.text}</span>
        {sum.failed > 0 && <span className="shrink-0 text-micro text-brick">{sum.failed} failed</span>}
      </button>
      {open && (
        <ol className="mt-1 space-y-1">
          {items.map((item) => (
            <Node key={item.id} item={item} items={all} tasks={tasks} onOpenDiff={onOpenDiff} onOpenFile={onOpenFile} />
          ))}
        </ol>
      )}
    </li>
  );
}

function Action({ icon: Glyph, label, onClick }: { icon: typeof Copy; label: string; onClick?: () => void }) {
  return (
    <button onClick={onClick} title={label} className="grid h-7 w-7 place-items-center rounded-md text-mute transition-colors hover:bg-raise hover:text-bone">
      <Glyph className="h-3.5 w-3.5" strokeWidth={1.75} />
    </button>
  );
}

function Thought({ item }: { item: Item }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button onClick={() => setOpen(!open)} className="flex w-full items-start gap-2 text-left text-meta text-mute transition-colors hover:text-dim">
        <ChevronRight className={`mt-1 h-3.5 w-3.5 shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`} strokeWidth={1.75} />
        <span className={open ? "leading-relaxed whitespace-pre-wrap" : ""}>{open ? item.text : "Thought for a moment"}</span>
      </button>
    </li>
  );
}

function ToolRow({ item, onOpenDiff, onOpenFile }: { item: Item } & Open) {
  const [open, setOpen] = useState(false);
  const { session } = useContext(SessionContext);
  const [notice, setNotice] = useState<string | null>(null);
  const failed = item.status === "Failed";
  const Glyph = GLYPH[item.kind] ?? Terminal;
  const line = said(item);
  const path = /\.[a-z0-9]+$/i.test(line) && !line.includes(" ") ? line : null;

  /* Asked before the tab opens, the way a path in the prose already is.
     Without it, anything ending in a dot and some letters became a tab — and
     a tool that worked on `/tmp/shot.png` opened a tab that could only ever
     spend twenty seconds asking the worker for a file it is not allowed to
     reach. A sentence now beats a spinner then. */
  const follow = async () => {
    if (!path || !session) return;
    const real = await resolvePath(session, path);
    /* Still a preview, the way a tool row has always opened one — the check
       added here is about whether it opens at all, not about how long it
       stays. */
    if (real) onOpenFile(real);
    else {
      setNotice(`${path} is not in this workspace.`);
      setTimeout(() => setNotice(null), 2500);
    }
  };

  return (
    <li className="ml-px border-l border-line pl-4">
      <div className="flex items-center gap-2.5 rounded-md px-2 py-1.5 font-mono text-code">
        <Icon of={Glyph} size={14} className={failed ? "text-brick" : "text-mute"} />
        <button onClick={() => setOpen(!open)} className="shrink-0 text-dim hover:text-bone">{DID[item.kind] ?? "used"}</button>
        <button
          onClick={() => {
            if (item.kind === "FileChange") onOpenDiff();
            else if (path) void follow();
            else setOpen(!open);
          }}
          className={`min-w-0 flex-1 truncate text-left ${failed ? "text-brick" : path ? "text-mute underline decoration-line underline-offset-2 hover:text-dim" : "text-mute"}`}
        >
          {line}
        </button>
        {item.status && item.status !== "Completed" && <span className={`shrink-0 text-micro ${failed ? "text-brick" : "text-mute"}`}>{item.status.toLowerCase()}</span>}
        {!item.status && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-slate" />}
      </div>
      {notice && <p className="px-2 pb-1 text-meta text-mute">{notice}</p>}
      {open && (
        <div className="mb-1 space-y-1.5 px-2">
          {item.input !== undefined && <pre className="scroll-slim max-h-40 overflow-auto rounded-md bg-panel px-3 py-2 font-mono text-micro whitespace-pre-wrap text-mute">{JSON.stringify(item.input, null, 2)}</pre>}
          {item.output && <pre className={`scroll-slim max-h-72 overflow-auto rounded-md bg-panel px-3 py-2 font-mono text-micro whitespace-pre-wrap ${failed ? "text-brick" : "text-dim"}`}>{item.output}</pre>}
        </div>
      )}
    </li>
  );
}

/** An edit shows what it did rather than saying that it did something. */
function Edited({ item, onOpenDiff }: { item: Item; onOpenDiff: () => void }) {
  const [open, setOpen] = useState(false);
  const edit = editFrom(item.input)!;
  const failed = item.status === "Failed";
  const removed = (edit.removed ?? "").split("\n");
  const added = (edit.added ?? "").split("\n");

  return (
    <li className="ml-px border-l border-line pl-4">
      <div className="flex items-center gap-2.5 rounded-md px-2 py-1.5 font-mono text-code">
        <Icon of={Pencil} size={14} className={failed ? "text-brick" : "text-mute"} />
        <button onClick={() => setOpen(!open)} className="shrink-0 text-dim hover:text-bone">changed</button>
        <button onClick={onOpenDiff} className={`min-w-0 flex-1 truncate text-left underline decoration-line underline-offset-2 ${failed ? "text-brick" : "text-mute hover:text-dim"}`}>{edit.path}</button>
        <span className="shrink-0 text-micro"><span className="text-sage">+{edit.added ? added.length : 0}</span> <span className="text-brick">−{edit.removed ? removed.length : 0}</span></span>
      </div>
      {open && (
        <div className="scroll-slim mb-1 max-h-80 overflow-auto rounded-md border border-line-soft bg-ground/50 font-mono text-code">
          {edit.removed && removed.map((l, i) => <div key={`r${i}`} className="flex gap-2 bg-brick-tint px-3 py-px text-brick"><span className="w-3 select-none opacity-60">−</span><span className="whitespace-pre">{l}</span></div>)}
          {edit.added && added.map((l, i) => <div key={`a${i}`} className="flex gap-2 bg-sage-tint px-3 py-px text-sage"><span className="w-3 select-none opacity-60">+</span><span className="whitespace-pre">{l}</span></div>)}
        </div>
      )}
    </li>
  );
}

/**
 * Work handed to a subagent: its own rail, one level in. Interleaved into the
 * main one, several voices narrate over each other and it reads as though the
 * agent you are talking to did all of it.
 */
function Delegated({ item, items, tasks, onOpenDiff, onOpenFile }: { item: Item; items: Item[]; tasks: Task[] } & Open) {
  const [open, setOpen] = useState(false);
  const task = tasks.find((t) => t.item === item.id);
  const mine = task ? items.filter((i) => i.task === task.id) : [];
  const input = item.input as Record<string, unknown> | undefined;
  const description = task?.description ?? (typeof input?.description === "string" ? input.description : undefined) ?? "a subagent";
  const failed = task?.status === "Failed" || item.status === "Failed";
  const rows = useMemo(() => fold(mine), [mine]);

  return (
    <li className="ml-px border-l border-line pl-4">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left font-mono text-code hover:bg-raise/60">
        <Icon of={Users} size={14} className={failed ? "text-brick" : "text-mute"} />
        <span className="shrink-0 text-dim">sent</span>
        <span className={`min-w-0 flex-1 truncate ${failed ? "text-brick" : "text-mute"}`}>{description}</span>
        {task?.progress && !task.summary && <span className="shrink-0 truncate text-micro text-mute">{task.progress}</span>}
        {!task?.status && !item.status && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-slate" />}
      </button>
      {open && (
        <div className="mt-1 pl-1">
          {rows.length > 0 && (
            <ol className="space-y-1">
              {rows.map((row) =>
                row.type === "item" ? (
                  <Node key={row.item.id} item={row.item} items={items} tasks={tasks} onOpenDiff={onOpenDiff} onOpenFile={onOpenFile} />
                ) : (
                  <Group key={row.id} items={row.items} all={items} tasks={tasks} onOpenDiff={onOpenDiff} onOpenFile={onOpenFile} />
                ),
              )}
            </ol>
          )}
          {task?.summary && (
            <div className="prose-desk mt-2 border-l border-line-soft pl-3">
              <Markdown>{task.summary}</Markdown>
            </div>
          )}
          {rows.length === 0 && !task?.summary && <p className="text-meta text-mute">Nothing back yet.</p>}
        </div>
      )}
    </li>
  );
}

/** What somebody was asked, and what they said. */
function Answered({ item }: { item: Item }) {
  const input = item.input as { questions?: { question: string }[] } | undefined;
  const pairs = [...(item.output ?? "").matchAll(/"([^"]+)"="([^"]*)"/g)].map((m) => [m[1], m[2]]);
  return (
    <li className="rounded-xl border border-line bg-panel px-4 py-3">
      {(input?.questions ?? []).map((q) => (
        <div key={q.question} className="py-1">
          <p className="text-ui text-dim">{q.question}</p>
          <p className="text-ui text-bone">{pairs.find(([k]) => k === q.question)?.[1] ?? "—"}</p>
        </div>
      ))}
      {!input?.questions?.length && <p className="text-ui text-dim">{item.output || item.text}</p>}
    </li>
  );
}

/** The agent's own checklist, drawn once above the transcript. */
function Plan({ steps }: { steps: PlanStep[] }) {
  return (
    <div className="mt-6 rounded-xl border border-line bg-panel px-4 py-3">
      <p className="text-meta text-mute">Plan</p>
      <ol className="mt-1.5 space-y-1">
        {steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2.5 text-ui">
            <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${String(s.status) === "Completed" ? "bg-sage" : String(s.status) === "InProgress" ? "bg-slate" : "bg-line"}`} />
            <span className={String(s.status) === "Completed" ? "text-mute line-through" : "text-text"}>{s.step}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Fetch → Worktree → Workspace → Setup → Launch, while it is happening. */
/**
 * The bring-up — fetch, worktree, workspace, setup, launch — drawn while it
 * happens and kept once it has: a record of how the place was made, folded
 * to one line so it stops taking the room the conversation needs.
 */
function BringUp({ steps }: { steps: ReturnType<typeof stepLines> }) {
  const done = steps.every((s) => s.state === "done");
  const failed = steps.some((s) => s.state === "failed");
  const [open, setOpen] = useState(false);
  if (done && !open) {
    return (
      <button onClick={() => setOpen(true)} className="mt-6 flex items-center gap-2.5 rounded-xl border border-line bg-panel px-4 py-2.5 text-left text-ui transition-colors hover:bg-raise/60">
        <Check className="h-3.5 w-3.5 shrink-0 text-sage" strokeWidth={2} />
        <span className="text-text">Workspace ready</span>
        <span className="text-micro text-mute">{steps.length} steps</span>
        <ChevronRight className="ml-auto h-3.5 w-3.5 text-mute" strokeWidth={2} />
      </button>
    );
  }
  return (
    <ol onClick={() => done && setOpen(false)} className={`mt-6 space-y-1 rounded-xl border bg-panel px-4 py-3 ${failed ? "border-brick-deep" : "border-line"} ${done ? "cursor-pointer" : ""}`}>
      {steps.map((s) => (
        <li key={s.step} className="flex items-center gap-2.5 text-ui">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.state === "done" ? "bg-sage" : s.state === "running" ? "animate-pulse bg-slate" : s.state === "failed" ? "bg-brick" : "bg-line"}`} />
          <span className={s.state === "pending" ? "text-mute" : s.state === "failed" ? "text-brick" : "text-text"}>{s.step}</span>
          {s.detail && <span className="min-w-0 truncate font-mono text-micro text-mute">{s.detail}</span>}
        </li>
      ))}
    </ol>
  );
}

/**
 * What the agent is doing right now, from the tail of the transcript.
 *
 * An item is open until `ItemCompleted` gives it a status, so the last item
 * says the phase: thinking, running commands, reading, editing, searching,
 * handing off — or streaming an answer, which needs no line at all because
 * the words are arriving on screen. Between items, plainly "Working".
 */
function phase(items: Item[]): string | null {
  const last = items[items.length - 1];
  if (!last || last.status || last.kind === "UserMessage") return "Working";
  switch (last.kind) {
    case "AssistantMessage":
      return null;
    case "Reasoning":
      return "Planning next moves";
    case "CommandExecution": {
      let n = 0;
      for (let i = items.length - 1; i >= 0 && items[i].kind === "CommandExecution" && !items[i].status; i--) n++;
      return n > 1 ? `Running ${n} commands` : "Running a command";
    }
    case "FileRead":
      return "Reading files";
    case "FileChange":
      return "Editing files";
    case "WebSearch":
      return "Searching the web";
    case "McpToolCall":
      return "Calling a tool";
    case "SubagentCall":
      return "Handing off to a subagent";
    case "Question":
      return null;
    default:
      return "Working";
  }
}

function Working({ heardAt, items }: { heardAt?: number; items: Item[] }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const ago = heardAt ? Math.round((Date.now() - heardAt) / 1000) : null;
  const doing = phase(items);
  /* Lit text rather than a dot: a band of light crossing the words. When the
     agent has gone quiet the words change, and stop moving — a sheen over
     "nothing heard for a minute" would be a lie. Nothing at all while an
     answer streams: the answer is the indicator. */
  const quiet = ago !== null && ago > 5;
  if (doing === null && !quiet) return null;
  return (
    <p className="mt-6 text-ui">
      {quiet ? <span className="text-mute">{doing ?? "Working"} — nothing heard for {ago}s</span> : <span className="text-sheen">{doing}</span>}
    </p>
  );
}

function Stopped({ why }: { why: string }) {
  return (
    <div className="mt-6 flex items-start gap-2.5 rounded-xl border border-brick-deep bg-brick-tint px-4 py-3">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-brick" strokeWidth={1.75} />
      <p className="text-ui text-text">{why}</p>
    </div>
  );
}

function Relaunch({ session }: { session: Session }) {
  const cache = useQueryClient();
  const relaunch = useRelaunchSession();
  return (
    <div className="mt-6 rounded-xl border border-ember-deep bg-panel px-4 py-3.5">
      <p className="text-ui text-text">The agent is not running. Its workspace, its branch and everything said so far are still here — starting it again picks the conversation up where it stopped.</p>
      {session.note && !session.note.startsWith("The agent is not running") && <p className="mt-2 font-mono text-meta text-mute">{session.note}</p>}
      <button
        disabled={relaunch.isPending}
        onClick={() => relaunch.mutate({ id: session.id }, { onSuccess: () => cache.invalidateQueries({ queryKey: getGetSessionQueryKey(session.id) }) })}
        className="control mt-3 bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute"
      >
        <RotateCcw className="h-3.5 w-3.5" strokeWidth={2} />
        Start it again
      </button>
    </div>
  );
}

/* ── Requests ──────────────────────────────────────────────────────────── */

function Approval({ sessionId, asked, onAnswered }: { sessionId: string; asked: Asked; onAnswered: () => void }) {
  const answer = useAnswerRequest();
  const [reason, setReason] = useState("");
  const [explaining, setExplaining] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const decide = (decision: Decision) => {
    setDone(decision.decision);
    onAnswered();
    answer.mutate({ id: sessionId, data: { req: asked.req, decision } });
  };

  if (done) {
    return (
      <div className="mt-8 flex items-center gap-2.5 text-meta text-mute">
        <Check className="h-4 w-4 text-sage" strokeWidth={2} />
        {done === "Deny" ? "Declined." : "Allowed."} The agent picked it up.
      </div>
    );
  }

  return (
    <div className="mt-8 overflow-hidden rounded-xl border border-ember-deep bg-ember-tint shadow-(--shadow-float)">
      <div className="px-5 pt-4">
        <div className="flex items-center gap-2.5">
          <span className="ember-pulse h-2 w-2 rounded-full bg-ember" />
          <span className="text-meta font-semibold text-ember-soft">{ASKING[asked.kind]} {asked.detail}</span>
        </div>
        <pre className="scroll-slim mt-3 max-h-44 overflow-auto rounded-lg bg-ground/60 px-3.5 py-2.5 font-mono text-code whitespace-pre-wrap text-bone">{what(asked)}</pre>
      </div>
      {explaining ? (
        <div className="mt-3 flex items-center gap-2 border-t border-ember-deep/40 px-5 py-3">
          <input
            autoFocus value={reason} onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") decide({ decision: "Deny", reason: reason.trim() || null }); if (e.key === "Escape") setExplaining(false); }}
            placeholder="Why not? The agent reads this."
            className="min-w-0 flex-1 bg-transparent text-ui text-bone placeholder:text-mute focus:outline-none"
          />
          <button onClick={() => decide({ decision: "Deny", reason: reason.trim() || null })} className="control border border-brick-deep text-brick hover:bg-brick-tint">Deny</button>
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-2 border-t border-ember-deep/40 px-5 py-3">
          <button onClick={() => decide({ decision: "Allow" })} className="control bg-bone font-medium text-ground hover:opacity-90">Allow</button>
          <button onClick={() => decide({ decision: "AllowAlways" })} className="control border border-line text-dim hover:text-bone">Always</button>
          <button onClick={() => setExplaining(true)} className="control ml-auto border border-line text-dim hover:border-brick-deep hover:text-brick">Deny</button>
        </div>
      )}
    </div>
  );
}

function Questions({ sessionId, asking, onAnswered }: { sessionId: string; asking: Questionnaire; onAnswered: () => void }) {
  const answer = useAnswerRequest();
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [written, setWritten] = useState<Record<string, string | undefined>>({});

  const pick = (question: string, label: string, many: boolean) => {
    setChosen((c) => {
      const had = c[question] ?? [];
      if (!many) return { ...c, [question]: [label] };
      return { ...c, [question]: had.includes(label) ? had.filter((l) => l !== label) : [...had, label] };
    });
    if (!many) setWritten((c) => ({ ...c, [question]: undefined }));
  };
  const answered = (q: string): string[] => {
    const own = written[q]?.trim();
    const picked = chosen[q] ?? [];
    return own ? [...picked, own] : picked;
  };
  const ready = asking.questions.every((q) => answered(q.question).length > 0);

  const send = () => {
    onAnswered();
    answer.mutate({
      id: sessionId,
      data: {
        req: asking.req,
        // Keyed by the question's own text, valued by the label — the agent
        // matches on both, so neither may be paraphrased on the way back.
        decision: { decision: "Answered", answers: Object.fromEntries(asking.questions.map((q) => [q.question, answered(q.question).join(", ")])) },
      },
    });
  };

  return (
    <div className="mt-8 overflow-hidden rounded-xl border border-ember-deep bg-ember-tint shadow-(--shadow-float)">
      <div className="flex items-center gap-2.5 px-5 pt-4">
        <span className="ember-pulse h-2 w-2 rounded-full bg-ember" />
        <span className="text-meta font-semibold text-ember-soft">Waiting on you</span>
      </div>
      <div className="space-y-5 px-5 pt-3 pb-4">
        {asking.questions.map((q) => (
          <div key={q.question}>
            <p className="text-lede text-bone">{q.question}</p>
            <div className="mt-3 grid gap-1.5">
              {q.options.map((o) => {
                const on = (chosen[q.question] ?? []).includes(o.label);
                return (
                  <button key={o.label} onClick={() => pick(q.question, o.label, !!q.multiSelect)} className={`flex items-start gap-3 rounded-lg border px-3.5 py-3 text-left transition-colors duration-150 ${on ? "border-ember-deep bg-ground/80" : "border-ember-deep/50 bg-ground/50 hover:border-ember-deep hover:bg-ground/80"}`}>
                    <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border border-ember-deep text-micro font-semibold ${on ? "bg-ember text-ground" : "bg-ember-tint text-ember-soft"}`}>{on ? <Check className="h-3 w-3" strokeWidth={3} /> : o.label[0]}</span>
                    <span className="min-w-0"><span className="block text-ui font-medium text-bone">{o.label}</span>{o.description && <span className="mt-0.5 block text-meta text-dim">{o.description}</span>}</span>
                  </button>
                );
              })}
            </div>
            <input value={written[q.question] ?? ""} onChange={(e) => setWritten((c) => ({ ...c, [q.question]: e.target.value }))} placeholder="Or answer in your own words" className="mt-2 w-full rounded-lg border border-ember-deep/40 bg-ground/40 px-3 py-2 text-ui text-bone placeholder:text-mute focus:border-ember-deep focus:outline-none" />
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-ember-deep/40 px-5 py-3">
        <button disabled={!ready} onClick={send} className="control bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute">Answer</button>
        <span className="text-micro text-mute">{asking.questions.length > 1 ? `${asking.questions.length} questions` : ""}</span>
      </div>
    </div>
  );
}
