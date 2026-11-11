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
import { createContext, Fragment, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { navigate } from "~/shims/next-navigation";
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronRight,
  CornerDownLeft,
  CornerUpLeft,
  CornerUpRight,
  Copy,
  Eye,
  FileText,
  GitBranch,
  Loader2,
  Pencil,
  RotateCcw,
  CircleSlash2,
  Search,
  Send,
  Diamond,
  Shapes,
  Terminal,
  Users,
  X,
} from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { HostMark, Icon } from "~/components/ui";
import { useHostOf, useHosts, useMachineGone } from "~/data";
import { Markdown } from "~/components/Markdown";
import { editFrom } from "~/components/EditCard";
import { stepLines } from "~/components/Steps";
import { delegating, useConversation, type Asked, type Item, type Questionnaire, type Task } from "~/api/conversation";
import { delegated, fold, mainline, summarise } from "~/api/steps";
import { relays, type Relay } from "~/api/relay";
import type { Artifact as ArtifactModel, Decision, Event, ItemKind, PlanStep, RequestKind, Session } from "~/api/generated/model";
import { useAnswerRequest, useRelaunchSession, getGetSessionQueryKey, sendTurn } from "~/api/generated/sessions/sessions";
import { asMessage, useNotes, type Note } from "~/api/notes";
import { forgetCheckout, landed, refused, settled, useCheckouts, type Run } from "~/api/checkouts";
import { useListEvents } from "~/api/generated/events/events";
import { elapsed, minutesSince } from "~/api/view";
import { Composer } from "~/ui/Composer";
import { why } from "~/data";
import { Dropping, type Hand } from "~/ui/attach";
import { folderRefusals, useFileDrop } from "~/ui/drop";
import { AccountSwitcher } from "~/ui/AccountSwitcher";
import { Annotate, type Anchor } from "~/ui/Annotate";
import { FindInChat } from "~/ui/FindInChat";
import { markPaths, resolvePath } from "~/paths";
import { ImagesFrom } from "~/components/WorkspaceImage";
import { ArtifactShot } from "~/components/ArtifactShot";
import { segments, splitMentions, type Read } from "~/mentions";
import { AddAgent } from "~/ui/AddAgent";

const DID: Partial<Record<ItemKind, string>> = {
  CommandExecution: "ran",
  SkillUse: "used",
  FileChange: "changed",
  FileRead: "read",
  McpToolCall: "called",
  WebSearch: "searched",
  SubagentCall: "sent",
};

const GLYPH: Partial<Record<ItemKind, typeof Terminal>> = {
  CommandExecution: Terminal,
  SkillUse: Diamond,
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
  lead = null,
  team = [],
  branch,
  onOpenDiff,
  onOpenFile,
  artifacts = [],
  onOpenArtifact,
}: {
  session: Session;
  /** The session that asked for this one, when one did and it is still listed. */
  lead?: Session | null;
  /**
   * The agents this one started.
   *
   * Here for one reason: a machine that restarts takes a whole family with
   * it, and a lead brought back without its team reads its history, finds it
   * delegated the work, and waits for reports nobody is writing. The card in
   * the dock has to be able to say how many stopped and offer to bring them
   * all back.
   */
  team?: Session[];
  branch?: string;
  artifacts?: ArtifactModel[];
  onOpenArtifact?: (id: string, title: string) => void;
} & Open) {
  const { conversation, echo, settle, remember, stopping, older } = useConversation(session.id);
  const mentionable = useMemo(() => ({ artifacts, open: onOpenArtifact }), [artifacts, onOpenArtifact]);
  const scroller = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  /* The sentinel above the transcript. Seeing it is a request for the
     exchanges before the ones drawn. */
  const earlier = useRef<HTMLDivElement>(null);
  /* How far the content extended below the viewport before a page of history
     landed. Restoring *that* rather than the scroll offset is what keeps the
     line somebody was reading under their eye: prepending moves everything
     down by the new page's height, and the distance to the bottom is the one
     measurement that height does not change. */
  const held = useRef<number | null>(null);

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
  /* Two questions, not one.

     `mayWrite` is the *place*: may I work in this workspace at all. `maySpeak`
     is this *conversation*, true only for the person who started it — because
     the agent runs on their subscription and pushes with their git token.
     Everything in this file is the conversation, so everything here asks the
     second one.

     `!== false` on both: a control plane older than this app sends neither,
     and reading their absence as "you may only watch" would take every control
     away from the person whose work it is. */
  const mayAct = session.maySpeak !== false;
  const mayWorkHere = session.mayWrite !== false;
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
    // A note becomes a turn for the agent, so making one is working here, not
    // watching. Selecting text to copy still works; only the prompt to turn it
    // into a note is gone.
    if (!mayAct) return;
    const sel = window.getSelection();
    const quote = sel?.toString().trim();
    if (!quote || quote.length < 2 || !sel?.anchorNode || sel.rangeCount === 0 || !body.current?.contains(sel.anchorNode)) return;
    const said = (sel.anchorNode.parentElement as HTMLElement | null)?.closest<HTMLElement>("[data-said]");
    if (!said) return;
    // Where the drag ended — a turn longer than the window has a selection box
    // whose bottom edge is off the bottom of it. See `FileTab`.
    // `copy` is the whole of it; `quote` is what fits on the card. Wanting the
    // passage rather than a note on it is the other half of this gesture.
    setDrafting({ quote: quote.length > 400 ? `${quote.slice(0, 400)}…` : quote, copy: quote, line: 0, label: "Note on what the agent said", item: said.dataset.said ?? "", x: e.clientX, y: e.clientY });
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
  /* The machine this ran on is not in this Firetower any more, so there is
     nothing at the other end of a message. `api/view.ts` says "only Ended is
     the end", and for these sessions that is false: nothing ended them —
     ending them would have taken this conversation with it — so the status
     says otherwise and the composer would stay live over a worker that does
     not exist. */
  const gone = useMachineGone(session.hostId);
  const answerable = session.status !== "Ended" && !gone;
  const recovery = useMemo(() => recoveryFor(session, team), [session, team]);
  /* Repositories being checked in, started from the toolbar's panel. Drawn
     here because this is where what happened to a workspace is written down. */
  const runs = useCheckouts(session.id);

  /* An ended session has no one to read the file and a workspace that is going
     away, so the pane stops offering. Refusing the drag outright is kinder
     than taking the file and then greying out the send button. */
  const { over, surface } = useFileDrop(
    ({ files, folders }) => hand.current?.(files, folderRefusals(folders)),
    answerable,
  );

  /* The main rail only. A subagent's work is drawn by the card that owns it,
     and drawing it here as well put the same `grep` on the screen twice —
     once where it read as though the agent you are talking to had run it. */
  const rows = useMemo(() => fold(mainline(items)), [items]);

  /* Where each artifact's card goes.
   *
   * By **log line**, not by searching the transcript for the artifact's
   * folder. That search could not work and three attempts at it did not: an
   * agent names a file however it likes, and one real session ran
   *
   *     cd …/.firetower/artifacts && cp firetower-architecture/index.html \
   *          firetower-architecture-copy/index.html
   *
   * after which the full path appears nowhere in the log, nothing matched,
   * and the card fell to the end of the conversation and stayed there.
   *
   * `first_seen_line` is stamped by the server when the artifact is first
   * published, from the agent's own log. It is a position rather than a
   * guess, it is unaffected by how the file was referred to, and because it
   * is written once the card stops where it started instead of following
   * later edits down the page.
   *
   * Three places a card can go, and getting this wrong is what kept it at the
   * bottom even once the line was right. The transcript is a *window* — this
   * session loads from line 6007 while the artifact was published at 5141 —
   * so "no row matches" has two very different meanings:
   *
   *   - **inside the window**: after the row the conversation had reached;
   *   - **before the window**: above the transcript, because it happened
   *     before everything on screen. Sending that case to the end put the
   *     oldest artifact under the newest message;
   *   - **no line at all** (published before this column existed): the end,
   *     which is the only honest answer when the position is unknown. */
  const mineHere = useMemo(
    () => artifacts.filter((a) => a.fromSessionId === session.id),
    [artifacts, session.id],
  );
  const placed = useMemo(() => {
    const at = new Map<number, typeof mineHere>();
    const before: typeof mineHere = [];
    const loose: typeof mineHere = [];

    /* The highest log line each row covers, so a card lands after the row the
       conversation had reached — not inside the middle of a folded group. */
    const reach = rows.map((row) => {
      const inRow = row.type === "item" ? [row.item] : row.items;
      return inRow.reduce((high, it) => Math.max(high, it.lineNo ?? 0), 0);
    });

    const known = reach.filter((r) => r > 0);
    const earliest = known.length > 0 ? Math.min(...known) : 0;

    for (const a of mineHere) {
      const line = a.firstSeenLine ?? 0;
      if (line <= 0) {
        loose.push(a);
        continue;
      }
      if (earliest > 0 && line < earliest) {
        before.push(a);
        continue;
      }
      let found = -1;
      for (let i = 0; i < reach.length; i++) {
        if (reach[i] > 0 && reach[i] <= line) found = i;
      }
      if (found >= 0) at.set(found, [...(at.get(found) ?? []), a]);
      else loose.push(a);
    }
    return { at, before, loose };
  }, [mineHere, rows]);

  /* Subagents that have not reported. The turn can end with these still
     going, and when it has they are the only thing still working — so they
     are what the line under the transcript has to be about. */
  const running = useMemo(
    () => conversation.tasks.filter((t) => t.status === undefined),
    [conversation.tasks],
  );

  /* ⌘F. The window has no browser find bar, and the conversation is the one
     place in the app long enough to need one — an afternoon of work with the
     command you are looking for somewhere in the middle of it.

     Bound here rather than in the workbench because `Chat` is only mounted
     while the conversation is the tab in front, so the key is the
     conversation's exactly when the conversation is what you are reading. */
  const [finding, setFinding] = useState(false);
  const [summoned, setSummoned] = useState(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "f") return;
      /* A focused terminal owns ⌘F — it searches its own scrollback, and
         swallows the key before it reaches here. Checked anyway, because the
         shell stays mounted behind a hidden panel. */
      if ((document.activeElement as HTMLElement | null)?.closest(".xterm")) return;
      e.preventDefault();
      setFinding(true);
      setSummoned((n) => n + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  /* The top of the transcript coming into view is a request for the exchanges
     before it. An observer rather than the scroll handler below, because this
     has to fire when the content moves under a still cursor as well as when
     the cursor moves — and because `older` is already safe to call repeatedly,
     the observer needs no debounce of its own. */
  useEffect(() => {
    const el = scroller.current;
    const mark = earlier.current;
    if (!el || !mark || !conversation.hasMore) return;
    const watch = new IntersectionObserver((seen) => seen.some((e) => e.isIntersecting) && older(), {
      root: el,
      // A screen early, so the page is usually there before the scroll is.
      rootMargin: `${el.clientHeight}px 0px 0px 0px`,
    });
    watch.observe(mark);
    return () => watch.disconnect();
  }, [conversation.hasMore, older]);

  /* Keeping somebody's place through a prepend.
     Recorded when a page is asked for and restored when it lands; in between,
     the browser has put the older exchanges above the viewport and pushed
     everything down by their height. The distance to the *bottom* is what is
     kept rather than the offset from the top, because that is the one
     measurement a prepend does not change.
     Skipped while following the end, where there is nothing to preserve and
     the effects above are already doing the right thing. */
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (conversation.loadingOlder) {
      held.current = el.scrollHeight - el.scrollTop;
      return;
    }
    if (held.current === null) return;
    if (!following.current) el.scrollTop = el.scrollHeight - held.current;
    held.current = null;
  }, [conversation.loadingOlder, conversation.items.length]);

  /* While the agent is talking, the end is checked every frame. A resize
     observer reports after layout and can trail a fast stream by a few
     frames, which reads as the page lagging behind the words and then
     catching up; a frame-by-frame check costs one comparison and keeps the
     last line pinned. Nothing runs while the agent is idle.

     And nothing runs while ⌘F is up. Opening the find bar is saying you are
     reading rather than watching, and a pin that fights the jump to a match
     is the one thing that would make searching a live session useless. */
  useEffect(() => {
    if (!working || finding) return;
    let raf = 0;
    const loop = () => {
      const el = scroller.current;
      if (el && following.current && el.scrollHeight - el.scrollTop - el.clientHeight > 1) el.scrollTop = el.scrollHeight;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [working, finding]);

  return (
    <div className="relative flex h-full min-h-0 flex-col" {...surface}>
      {over && <Dropping />}
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onMouseUp={takeSelection}
        className="scroll-slim min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
        onScroll={(e) => {
          const el = e.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <SessionContext.Provider value={{ session: session.id, mayAct }}>
        <MentionsContext.Provider value={mentionable}>
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

          {/* Whose work this is part of. A session another session asked for
              says so at the top, because "why does this exist" is the first
              question anyone asks about a workspace they did not open — and
              because what it says when it finishes goes to that session, not
              to the inbox. */}
          {session.parentId && (
            <button
              onClick={() => navigate(`/sessions/${lead?.workspaceId ?? session.parentId}`)}
              title={`Started by ${lead?.name ?? "another session"}${session.spawnReason ? ` — ${session.spawnReason}` : ""}. It reports back here.`}
              className="group mt-3 flex w-full items-center gap-2 rounded-lg border border-line-soft bg-raise/40 px-3 py-1.5 text-left text-meta transition-colors hover:border-dim hover:bg-raise"
            >
              <CornerUpLeft className="h-3.5 w-3.5 shrink-0 text-slate" strokeWidth={1.75} />
              <span className="shrink-0 text-mute">from</span>
              <span className="min-w-0 max-w-[45%] shrink truncate font-medium text-bone">
                {lead?.name ?? "another session"}
              </span>
              {session.spawnReason && (
                <span className="min-w-0 flex-1 truncate text-mute">— {session.spawnReason}</span>
              )}
            </button>
          )}

          {steps.length > 0 && <BringUp steps={steps} />}

          {conversation.plan.length > 0 && <Plan steps={conversation.plan} />}

          {items.length === 0 && !working && steps.every((s) => s.state === "done") && (
            <p className="mt-10 text-read text-mute">
              {/* "The agent is here" is the one thing that is not true of a
                  session whose machine restarted, and this drew it under the
                  card offering to bring the agent back. The same species of
                  bug as the one this screen exists to fix: an interface
                  asserting something about a session that is not so. */}
              {conversation.trouble ??
                (recovery
                  ? "Nothing was said before the machine restarted."
                  : "Nothing said yet. The agent is here and waiting for you.")}
            </p>
          )}

          {/* The top of what has been read, and the request for what is above
              it. Nothing at all when the conversation arrived whole, which is
              most of them — a transcript that was never cut should carry no
              hint that it might have been. */}
          {conversation.hasMore && (
            <div ref={earlier} className="mt-9 flex h-8 items-center justify-center">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-mute" strokeWidth={2} />
            </div>
          )}

          {/* Published before anything on screen. Above the transcript, not
              below it — the window is the last few exchanges, and an artifact
              older than all of them is not the newest thing that happened. */}
          {onOpenArtifact &&
            placed.before.map((a) => <ArtifactCard key={a.id} artifact={a} onOpen={onOpenArtifact} />)}

          <ol className="mt-9 space-y-7">
            {rows.map((row, i) => (
              <Fragment key={row.type === "item" ? row.item.id : row.id}>
                {row.type === "item" ? (
                  <Node item={row.item} items={items} tasks={conversation.tasks} onOpenDiff={onOpenDiff} onOpenFile={onOpenFile} />
                ) : (
                  <Group items={row.items} all={items} tasks={conversation.tasks} onOpenDiff={onOpenDiff} onOpenFile={onOpenFile} />
                )}
                {onOpenArtifact &&
                  (placed.at.get(i) ?? []).map((a) => (
                    <li key={a.id}>
                      <ArtifactCard artifact={a} onOpen={onOpenArtifact} />
                    </li>
                  ))}
              </Fragment>
            ))}
          </ol>

          {/* Only the ones whose write is not in the loaded transcript. The
              rest sit where they were made, above. */}
          {onOpenArtifact &&
            placed.loose.map((a) => <ArtifactCard key={a.id} artifact={a} onOpen={onOpenArtifact} />)}

          {/* After the transcript, because it is the newest thing that
              happened here — and the agent's own acknowledgement of it arrives
              in the turn below. */}
          {runs.map((run) => (
            <CheckingIn key={run.id} sessionId={session.id} run={run} />
          ))}

          {working && <Working heardAt={conversation.heardAt} items={items} delegates={running} inTurn={conversation.inTurn === true} />}
          {stopped && <Stopped why={stopped} />}
          {/* The card that explains the whole state, and offers nothing.
              Instead of `Relaunch`, not beside it: starting again is the one
              thing that cannot happen here. */}
          {gone ? <MachineRemoved /> : session.status === "Failed" && <Relaunch session={session} />}
          {/* Where the transcript was cut off. Not a card wrapped round the
              turn above it: those words are genuinely what the agent wrote and
              they should read as prose. This is the join, drawn as a join —
              and a join needs something on both sides of it, so a session that
              said nothing before its machine went gets the line above instead
              of a seam across nothing. */}
          {!gone && recovery && items.length > 0 && <Seam />}

          {questions.map((q) => (
            <Questions key={q.req} sessionId={session.id} asking={q} onAnswered={() => settle(q.req)} />
          ))}
          {asked.map((a) => (
            <Approval key={a.req} sessionId={session.id} asked={a} onAnswered={() => settle(a.req)} />
          ))}

        </div>
        </NotesContext.Provider>
        </ImagesFrom.Provider>
        </MentionsContext.Provider>
        </SessionContext.Provider>
      </div>

      {finding && (
        <FindInChat scroller={scroller} body={body} summoned={summoned} onClose={() => setFinding(false)} />
      )}

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
          <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-line lift py-1.5 pr-1.5 pl-3.5 shadow-(--shadow-float)">
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
      {/* Two ways in, and only one of them carries notes. From the notes bar
          this hands the selected ones to a new agent; from the card somebody
          watching gets, there are none and it is simply "start an agent here".
          `asMessage` answers both. */}
      {handing && <AddAgent session={session} workspaceId={session.workspaceId ?? session.id} prompt={asMessage(notes)} onClose={() => setHanding(false)} onStarted={clear} />}
      </div>

      {/* A viewer gets no composer at all.
          Disabling it would be worse than leaving it out: a text box you can
          click into, type in and press send on, which then fails, is how this
          was found — the send was refused, the echo had already been added,
          and the transcript sat there saying "Working — nothing heard". There
          is nothing to type, so there is no box.

          `maySpeak`, not `mayWrite`. The second is the room — whether you may
          work in this workspace at all. This is the conversation, which runs
          on its owner's subscription and pushes with their git token, so it is
          theirs whatever the room was shared at. Both come from the server,
          computed with the predicates that enforce them; neither can be worked
          out here, because being named on one workspace is an exception on the
          resource, in no directory, and nothing this client holds mentions it.

          `!== false`, not truthiness: a control plane older than this app does
          not send the field at all, and reading its absence as "you may only
          watch" would take the composer away from everybody on it — which it
          promptly did, to the owner of the workspace. */}
      {mayAct && !gone && recovery ? (
        /* In the composer's place, not above it.
           The composer's promise is that something will read this, and nothing
           will: the agent is gone. A disabled box beside a card explaining why
           is two objects saying one thing — and this is the same argument
           `Watching` below already settled for a viewer. The dock is the most
           valuable space on the screen, and the thing that belongs in it is
           the thing that brings the agent back. */
        <Recover
          session={session}
          team={recovery.team}
          notYours={recovery.notYours}
          itself={recovery.itself}
          spoke={items.length > 0}
        />
      ) : mayAct ? (
        <AccountSwitcher session={session} working={working}>
          <Composer
            session={session}
            conversation={conversation}
            onEcho={echo}
            onRemember={remember}
            onStopping={stopping}
            disabled={!answerable}
            whyNot={gone ? "No machine to send this to — the machine this workspace ran on has been removed." : undefined}
            asking={asked.length + questions.length > 0}
            hand={hand}
          />
        </AccountSwitcher>
      ) : (
        <Watching whose={session.ownerName} mayWorkHere={mayWorkHere} onStart={() => setHanding(true)} />
      )}
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
    /* A result a child handed back, or a steer from a lead, arrives as a user
       turn — the only thing an agent reads as input — so without this it would
       draw as a bubble from you. Drawn instead as a card from the other agent.
       Usually one; a lead that was mid-turn when several children reported gets
       them in one turn, so there can be more. */
    const relayed = relays(item.text);
    if (relayed.length > 0) {
      return (
        <>
          {relayed.map((r, i) => (
            <Relayed key={i} relay={r} />
          ))}
        </>
      );
    }
    /* The block the composer wrote under the message comes back out as
       chips, and the handles in the sentence are drawn as handles. The text
       is still what the agent read; nothing here is a second copy of it. */
    const { said, mentions } = splitMentions(item.text ?? "");
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
          {said && (
            <p className="whitespace-pre-wrap">
              {mentions.length === 0
                ? said
                : segments(
                    said,
                    mentions.map((m) => m.handle),
                  ).map((s, i) =>
                    s.kind === "handle" ? (
                      <span key={i} className="rounded bg-overlay px-1 font-mono text-code text-bone">
                        {s.value}
                      </span>
                    ) : (
                      <Fragment key={i}>{s.value}</Fragment>
                    ),
                  )}
            </p>
          )}
          {mentions.length > 0 && <Mentioned mentions={mentions} />}
        </div>
      </li>
    );
  }

  if (item.kind === "AssistantMessage") return <Said item={item} onOpenFile={onOpenFile} />;

  if (item.kind === "Reasoning") return <Thought item={item} />;
  if (item.kind === "SkillUse") return <Reached item={item} />;
  if (item.kind === "Question") return <Answered item={item} />;
  if (item.kind === "SubagentCall") return <Delegated item={item} items={items} tasks={tasks} onOpenDiff={onOpenDiff} onOpenFile={onOpenFile} />;
  if (item.kind === "FileChange" && editFrom(item.input)) return <Edited item={item} onOpenDiff={onOpenDiff} />;

  return <ToolRow item={item} onOpenDiff={onOpenDiff} onOpenFile={onOpenFile} />;
}

/**
 * The agent reaching for a skill.
 *
 * One line, not a card with a fold. Nothing happened to the repository — the
 * agent read the instructions it had been given and went on — so it belongs
 * beside the greps and the reads rather than above them, and the only fact
 * worth the width is *which* skill.
 *
 * The name comes from `input.skill`, which every reader writes whatever its
 * agent called the tool: Claude Code has a `Skill` tool, Codex has
 * `skills.read`, and Kimi has no skill tool at all and simply reads the
 * `SKILL.md`. Three spellings, one key — see `normalise::skill_reached_for`.
 */
function Reached({ item }: { item: Item }) {
  const named =
    (item.input as { skill?: string } | undefined)?.skill ??
    (item.title && item.title !== "Skill" ? item.title : null);

  return (
    <div className="flex items-baseline gap-2 py-0.5 text-meta text-mute">
      <Diamond className="h-3 w-3 shrink-0 translate-y-px text-slate" strokeWidth={2} />
      <span>skill</span>
      <span className="font-mono text-code text-text">{named ?? "one of yours"}</span>
    </div>
  );
}

/** Which session the turns belong to — for the paths in them. */
/**
 * Which session is being read, and whether the reader may steer it.
 *
 * `mayAct` rides along with the id because every control that needs it already
 * needs the id, and the alternative was a second prop threaded through four
 * components that have no other reason to know about permissions.
 */
const SessionContext = createContext<{ session: string | null; mayAct: boolean }>({
  session: null,
  mayAct: true,
});

/** The notes so far, and how to take one back — read by the turn it is on. */
const NotesContext = createContext<{ notes: Note[]; drop: (id: string) => void }>({ notes: [], drop: () => {} });

/**
 * What a mention in somebody's message is resolved against, and what opening
 * one does. The bubble reads the mention back out of the text it was written
 * into (`splitMentions`) and finds the artifact in the list the cards use.
 */
const MentionsContext = createContext<{ artifacts: ArtifactModel[]; open?: (id: string, title: string) => void }>({ artifacts: [] });

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

/**
 * An artifact, where the turn that made it ended.
 *
 * Not a rounded card around prose — the same treatment a picture the agent
 * pointed at already gets, which is a border around *the bytes* and nothing
 * around the sentence. The thumbnail is the artifact itself in a frame,
 * scaled: no screenshot service, no headless browser on the control plane.
 */
function ArtifactCard({ artifact, onOpen }: { artifact: ArtifactModel; onOpen: (id: string, title: string) => void }) {
  return (
    <div className="mt-6 max-w-[26rem]">
      <button
        onClick={() => onOpen(artifact.id, artifact.title)}
        title="Open it beside the conversation"
        className="group/art block w-full"
      >
        <ArtifactShot artifact={artifact} className="group-hover/art:border-mute" />
      </button>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="text-ui font-medium text-bone">{artifact.title}</span>
        <span className="font-mono text-micro text-mute">v{artifact.version}</span>
        <span className="ml-auto text-micro text-mute">{elapsed(minutesSince(artifact.updatedAt))} ago</span>
      </div>
    </div>
  );
}

/**
 * The artifacts a message mentioned, as chips under it.
 *
 * Resolved by handle against the list the cards use — the slug at that
 * version, then the slug with its number taken off, then the title — so the
 * chip has the picture and opens the artifact beside the conversation. One
 * that is no longer in the list (deleted since) is still named, with the
 * glyph and nowhere to go.
 */
function Mentioned({ mentions }: { mentions: Read[] }) {
  const { artifacts, open } = useContext(MentionsContext);
  const find = (m: Read) => {
    const slug = m.handle.replace(/-\d+$/, "");
    return (
      artifacts.find((a) => a.slug === m.handle && a.version === m.version) ??
      artifacts.find((a) => a.slug === slug && a.title === m.title) ??
      artifacts.find((a) => a.title === m.title) ??
      artifacts.find((a) => a.slug === m.handle) ??
      artifacts.find((a) => a.slug === slug)
    );
  };
  const look = "flex max-w-full items-center gap-2 rounded-lg border border-line bg-panel py-1 pr-2.5 pl-1 text-text";
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {mentions.map((m) => {
        const found = find(m);
        const inner = (
          <>
            <span className="block w-9 shrink-0 overflow-hidden rounded">
              {found ? (
                <ArtifactShot artifact={found} framed={false} />
              ) : (
                <span style={{ aspectRatio: "16 / 10" }} className="grid w-full place-items-center bg-line text-dim">
                  <Shapes className="h-3 w-3" strokeWidth={1.5} />
                </span>
              )}
            </span>
            <span className="truncate text-meta">{m.title}</span>
            <span className="shrink-0 font-mono text-micro text-mute">v{m.version}</span>
          </>
        );
        return found && open ? (
          <button key={m.handle} onClick={() => open(found.id, found.title)} title="Open it beside the conversation" className={`${look} transition-colors hover:border-mute hover:text-bone`}>
            {inner}
          </button>
        ) : (
          <span key={m.handle} title={m.path} className={look}>
            {inner}
          </span>
        );
      })}
    </div>
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
      {/* Outside the fold on purpose. A screenshot is the thing you came to
          look at, and one behind a disclosure triangle is one nobody sees —
          which is the whole complaint this answers. Smaller than a picture in
          prose: this is a step, not the point being made. */}
      {item.images && item.images.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-2 pb-1.5">
          {item.images.map((image, i) => (
            <img key={i} src={`data:${image.mediaType};base64,${image.data}`} alt="" className="max-h-64 max-w-full rounded-md border border-line object-contain" />
          ))}
        </div>
      )}
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
  const mine = task ? delegated(items, task.id) : [];
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

/**
 * A message from another agent, drawn so it is not mistaken for yours.
 *
 * A child's hand-back, a child's mid-task check-in, or a lead's steer reaches
 * the agent as a user turn, so the transcript would otherwise draw it as a
 * bubble from you — which is a lie about who spoke. Left of the thread, with
 * the other session named and a line down the side in the tone its direction
 * carries: sage for a child reporting a result, slate for a check-in or a lead
 * steering. Collapsed to a line by default — the summary is the agent's to
 * read, and yours to open when you want it.
 */
function Relayed({ relay }: { relay: Relay }) {
  const [open, setOpen] = useState(false);
  // A hand-back and a check-in both come *in* from a child; a steer goes out.
  const incoming = relay.kind === "handback" || relay.kind === "update";
  const tone =
    relay.kind === "handback"
      ? { border: "border-sage-deep", icon: "text-sage", label: "handed back" }
      : relay.kind === "update"
        ? { border: "border-slate-deep", icon: "text-slate", label: "checked in" }
        : { border: "border-slate-deep", icon: "text-slate", label: "steered" };
  const preview = relay.body.split("\n").find((l) => l.trim())?.trim() ?? "";
  const rendered = useMemo(() => <Markdown>{relay.body}</Markdown>, [relay.body]);

  return (
    <li className={`border-l-2 pl-3 ${tone.border}`}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setOpen(!open)}
        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-raise/60"
      >
        <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-mute transition-transform duration-150 ${open ? "rotate-90" : ""}`} strokeWidth={1.75} />
        <Icon of={incoming ? CornerDownLeft : CornerUpRight} size={14} className={tone.icon} />
        {/* The other session's name, a way into it. A button, not nested in the
            row's button — this is a div with a click, so that is allowed. */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            navigate(`/sessions/${relay.id}`);
          }}
          className="min-w-0 max-w-[60%] shrink truncate font-mono text-code text-bone hover:underline"
          title={relay.name}
        >
          {relay.name}
        </button>
        <span className="shrink-0 text-meta text-mute">{tone.label}</span>
        {!open && preview && <span className="min-w-0 flex-1 truncate text-meta text-dim">{preview}</span>}
      </div>
      {open && (
        <div className="prose-desk mt-1 pl-1">{rendered}</div>
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
 * Repositories being checked in, drawn the way the bring-up is.
 *
 * Adding a repository to a running workspace is the bring-up's first two steps
 * done again, so it is said in the same place and in the same shape — one card
 * in the transcript, a line per repository, a tick or a cross on each. A run of
 * three used to be three requests reporting only into the popover that started
 * them, which meant the one that failed was a red line under a panel you had
 * already closed.
 *
 * A run where everything landed folds to a line, like the bring-up. One where
 * something did not stays open and keeps its crosses, because that is the card
 * somebody needs to read.
 */
function CheckingIn({ sessionId, run }: { sessionId: string; run: Run }) {
  const hostOf = useHostOf();
  const over = settled(run);
  const bad = refused(run);
  const good = landed(run);
  const [open, setOpen] = useState(false);

  if (over && bad === 0 && !open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-6 flex w-full items-center gap-2.5 rounded-xl border border-line bg-panel px-4 py-2.5 text-left text-ui transition-colors hover:bg-raise/60"
      >
        <Check className="h-3.5 w-3.5 shrink-0 text-sage" strokeWidth={2} />
        <span className="text-text">
          {good === 1 ? "Repository checked in" : `${good} repositories checked in`}
        </span>
        <ChevronRight className="ml-auto h-3.5 w-3.5 text-mute" strokeWidth={2} />
      </button>
    );
  }

  return (
    <div className={`mt-6 rounded-xl border bg-panel px-4 py-3 ${bad > 0 ? "border-brick-deep" : "border-line"}`}>
      <div className="flex items-center gap-2.5">
        {over ? (
          bad > 0 ? (
            <X className="h-3.5 w-3.5 shrink-0 text-brick" strokeWidth={2} />
          ) : (
            <Check className="h-3.5 w-3.5 shrink-0 text-sage" strokeWidth={2} />
          )
        ) : (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-slate" strokeWidth={2} />
        )}
        <span className="text-ui text-text">
          {over
            ? bad > 0
              ? `${good} of ${run.repos.length} checked in`
              : `${good === 1 ? "Repository" : `${good} repositories`} checked in`
            : `Checking in ${run.repos.length === 1 ? "a repository" : `${run.repos.length} repositories`}`}
        </span>
        {over && (
          <button
            onClick={() => (bad > 0 ? forgetCheckout(sessionId, run.id) : setOpen(false))}
            title={bad > 0 ? "Dismiss" : "Fold it away"}
            className="ml-auto grid h-6 w-6 place-items-center rounded text-mute transition-colors hover:bg-raise hover:text-bone"
          >
            <X className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        )}
      </div>

      <ol className="mt-2.5 space-y-1.5">
        {run.repos.map((r) => (
          <li key={r.slug} className="flex items-start gap-2.5 text-ui">
            <span className="mt-0.5 grid h-3.5 w-3.5 shrink-0 place-items-center">
              {r.state === "done" ? (
                <Check className="h-3.5 w-3.5 text-sage" strokeWidth={2} />
              ) : r.state === "failed" ? (
                <X className="h-3.5 w-3.5 text-brick" strokeWidth={2} />
              ) : r.state === "fetching" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-slate" strokeWidth={2} />
              ) : (
                <span className="h-1.5 w-1.5 rounded-full bg-line" />
              )}
            </span>
            <HostMark kind={hostOf(r.slug)?.kind} size={12} className={`mt-1 ${r.state === "failed" ? "text-brick" : "text-mute"}`} />
            <span className="min-w-0 flex-1">
              <span className={`block truncate font-mono ${r.state === "failed" ? "text-brick" : r.state === "waiting" ? "text-mute" : "text-text"}`}>
                {r.slug}
              </span>
              {/* The worker's own sentence where it landed, and the host's
                  refusal where it did not. Neither is rewritten here. */}
              {r.detail && (
                <span className={`block font-mono text-micro ${r.state === "failed" ? "whitespace-pre-wrap text-brick/80" : "truncate text-mute"}`}>
                  {r.detail}
                </span>
              )}
              {!r.detail && r.state === "fetching" && (
                <span className="block font-mono text-micro text-mute">fetching and cutting the worktree…</span>
              )}
              {!r.detail && r.state === "waiting" && (
                <span className="block font-mono text-micro text-mute">waiting its turn</span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

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

function Working({
  heardAt,
  items,
  delegates,
  inTurn,
}: {
  heardAt?: number;
  items: Item[];
  /** Subagents still running, which may be all that is. */
  delegates: Task[];
  /** Whether the main agent is still going, or only its subagents are. */
  inTurn: boolean;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const ago = heardAt ? Math.round((Date.now() - heardAt) / 1000) : null;
  /* What a subagent last said it was doing beats guessing from the transcript:
     once the turn has ended the newest item is whatever the main agent did
     last, which is over. */
  /* While the turn is open the main agent is the story and the subagent has
     its own card to narrate in. Once it has ended, the subagent is the only
     thing still working — and `phase` would be reading an item that finished
     before the turn did. */
  const doing = inTurn || delegates.length === 0 ? phase(items) : delegating(delegates);
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

/**
 * A workspace whose machine is not in this Firetower any more.
 *
 * Every sentence here is load-bearing, and the one that matters most is the
 * second: a session on the retired machine still reads as running, because
 * marking it `Ended` would make `reclaim::sweep` delete the workspace and with
 * it this conversation — the only record of what that agent did. Without
 * saying so, a running status on a machine that does not exist reads as
 * Firetower being broken.
 *
 * **No buttons.** The previous draft of this offered "start it again on a
 * machine": a new workspace on the same branch name, which half the people who
 * saw it would read as *resume* and the other half would press, quietly
 * leaving the uncommitted work in a worktree nothing can reach. Starting fresh
 * on a branch is an ordinary thing to do by the ordinary route.
 */
function MachineRemoved() {
  return (
    <div className="mt-6 rounded-xl border border-line bg-panel px-4 py-3.5">
      <p className="text-ui text-text">This workspace ran on a machine that has been removed.</p>
      <p className="mt-2 text-meta text-dim">
        Nothing here is running. Its status still says otherwise, and that is deliberate — ending it
        would have taken this conversation with it.
      </p>
      <p className="mt-1.5 text-meta text-dim">
        Everything above stays readable. The worktree is still on that machine, under the worker&rsquo;s
        own directory; Firetower has no route to it.
      </p>
    </div>
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

/**
 * Whether a machine restarting left this conversation needing a way back, and
 * what a press would have to cover.
 *
 * Two shapes, and the second is the one that is easy to miss. This agent may
 * be the one that stopped — `Stranded` — or it may have handed back before the
 * machine went, in which case its own status is honest and the agents it
 * delegated to are the ones that are gone. The second still needs the
 * affordance: it is waiting for a report that is never coming, and `Chat` drew
 * nothing at all for it.
 *
 * Pure, and exported, because the question is worth a test of its own: the
 * cost of getting it wrong is a conversation with no way out of it, which is
 * the bug this whole change is about.
 */
export function recoveryFor(
  session: Session,
  team: Session[],
): { itself: boolean; team: Session[]; notYours: number } | null {
  const stopped = team.filter((t) => t.status === "Stranded");
  /* What this person may actually start, and what they may not.
   *
   * A workspace can be shared while the agents inside it are not, and a child
   * runs on the subscription its own owner pinned to it — so a button that
   * counted every stranded child would promise to spend somebody else's
   * credit. The server refuses those and says how many it left; this is the
   * same question asked early, so the number on the button is the number that
   * will happen. `!== false` because a control plane older than this app sends
   * neither field, and reading their absence as "not yours" would take the
   * recovery away from the person whose work it is. */
  const mine = stopped.filter((t) => t.mayWrite !== false);
  const found = {
    team: mine,
    notYours: stopped.length - mine.length,
  };
  if (session.status === "Stranded") return { itself: true, ...found };
  /* Only `HandedBack`. A lead that is `Working` is either working or waiting
     on its children, and `Working` with a team that stopped is a lead whose
     own agent is still there — it finds out the ordinary way, by being told
     what became of them. */
  if (session.status === "HandedBack" && stopped.length > 0) {
    return { itself: false, ...found };
  }
  return null;
}

/**
 * Where the transcript stops mid-sentence.
 *
 * One line, and it says the thing nobody can work out by looking: the last
 * tool call started and nothing records whether it finished. The agent's log
 * is flushed as it goes, so everything above is real — there is simply no line
 * saying the write landed, which makes the file on disk the only answer.
 */
export function Seam() {
  return (
    <div className="mt-6 flex items-center gap-3">
      <span className="h-px flex-1 bg-amber-deep/50" />
      <span className="text-meta text-amber">cut off when the machine restarted</span>
      <span className="h-px flex-1 bg-amber-deep/50" />
    </div>
  );
}

/**
 * What stands in the composer's place when the machine under the work
 * restarted.
 *
 * **The body is the promise the feature is judged against**, and it is the
 * whole body: it comes back having read the conversation, and the turn it was
 * cut off in is not finished for free. It deliberately does not say *resume*,
 * *pick up where it left off* or *continue* — all three are true of the
 * conversation and false of the work, and that gap is the thing a person gets
 * wrong here.
 *
 * **The family is the default.** A lead that comes back alone finds it
 * delegated the work and waits for reports nobody is writing, so the primary
 * action brings the team back too — team first, lead last, which is the
 * server's to order — with *this agent only* beside it for whoever wants just
 * the one.
 */
export function Recover({
  session,
  team,
  notYours = 0,
  itself,
  spoke = true,
}: {
  session: Session;
  /** Its agents that stopped with it, and that this person may start. */
  team: Session[];
  /** How many more stopped that are somebody else's to bring back. */
  notYours?: number;
  /** Whether this agent is one of the stopped ones, or is waiting on them. */
  itself: boolean;
  /** Whether there is a conversation above this to come back to. */
  spoke?: boolean;
}) {
  const cache = useQueryClient();
  const relaunch = useRelaunchSession();
  const fleet = useHosts();
  const machine = fleet.data.find((h) => h.id === session.hostId)?.name;
  /* Everything a press would start, which always includes this agent: a lead
     that handed back before its machine went has no agent either — that is why
     it is being offered a way back — and it has to be there to read what its
     team finished. */
  const all = team.length + 1;
  const bring = (family: boolean) =>
    relaunch.mutate(
      { id: session.id, params: family ? { family: true } : undefined },
      { onSuccess: () => cache.invalidateQueries({ queryKey: getGetSessionQueryKey(session.id) }) },
    );

  return (
    /* The composer's own slot and the composer's own measure, so what is in
       the dock is the same shape whichever of the two it is. */
    <div className="shrink-0 px-8 pb-6">
      <div className="mx-auto w-full max-w-[46rem] rounded-2xl border border-amber-deep/60 bg-panel px-5 py-4 shadow-(--shadow-float)">
        <div className="flex items-center gap-2.5">
          <CircleSlash2 className="h-4 w-4 shrink-0 text-amber" strokeWidth={1.75} />
          <p className="text-ui font-mid text-text">
            {itself ? "Stopped when" : "Its team stopped when"} {machine ?? "the machine"} restarted
          </p>
        </div>
        <p className="mt-2 text-meta text-dim">
          {/* The promise has to be true of *this* session. A workspace whose
              machine went before the agent said a word has no conversation to
              come back having read, and saying it anyway is the same kind of
              untruth as the spinner this screen replaced. */}
          {!itself
            ? "This agent is waiting for a report that isn’t coming."
            : spoke
              ? "Comes back having read this conversation. Won’t finish the cut-off turn."
              : "Comes back to this workspace."}
        </p>
        {itself && team.length + notYours > 0 && (
          <p className="mt-1 text-meta text-mute">
            {team.length + notYours} of its team stopped too.
            {notYours > 0 && ` ${notYours} ${notYours === 1 ? "isn’t" : "aren’t"} yours to start.`}
          </p>
        )}
        <div className="mt-3.5 flex items-center gap-2">
          <button
            disabled={relaunch.isPending}
            onClick={() => bring(all > 1)}
            className="control bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute"
          >
            <RotateCcw className="h-3.5 w-3.5" strokeWidth={2} />
            {all > 1 ? `Bring back all ${all}` : "Bring it back"}
          </button>
          {itself && team.length > 0 && (
            <button
              disabled={relaunch.isPending}
              onClick={() => bring(false)}
              className="control text-dim hover:bg-raise hover:text-bone disabled:text-mute"
            >
              This agent only
            </button>
          )}
        </div>
        {/* The reason it would not start, to the person who pressed it. The
            note carries the same thing for anybody who arrives later, and the
            session stays stranded either way — nothing about the workspace
            changed. */}
        {relaunch.error && <p className="mt-2 text-meta text-brick">{why(relaunch.error)}</p>}
      </div>
    </div>
  );
}

function Relaunch({ session }: { session: Session }) {
  const cache = useQueryClient();
  const relaunch = useRelaunchSession();
  return (
    <div className="mt-6 rounded-xl border border-ember-deep bg-panel px-4 py-3.5">
      {/* Shorter than it was, and no longer promising something it cannot
          deliver: nothing picks a turn up where it stopped. The same sentence
          as the recovery card, because it is the same fact. */}
      <p className="text-ui text-text">The agent stopped. Comes back having read this conversation; won&rsquo;t finish the cut-off turn.</p>
      {session.note && !session.note.startsWith("The agent stopped") && <p className="mt-2 font-mono text-meta text-mute">{session.note}</p>}
      <button
        disabled={relaunch.isPending}
        onClick={() => relaunch.mutate({ id: session.id }, { onSuccess: () => cache.invalidateQueries({ queryKey: getGetSessionQueryKey(session.id) }) })}
        className="control mt-3 bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute"
      >
        <RotateCcw className="h-3.5 w-3.5" strokeWidth={2} />
        Bring it back
      </button>
      {/* A restart that does not take says why, here and now. The session's
          note carries the same reason for anybody who arrives later, but this
          is the person who pressed it: dropping the answer left "it did not
          restart" as the whole of what they got, which is an invitation to
          press the button again rather than to fix anything. */}
      {relaunch.error && <p className="mt-2 text-meta text-brick">{why(relaunch.error)}</p>}
    </div>
  );
}

/* ── Requests ──────────────────────────────────────────────────────────── */

function Approval({ sessionId, asked, onAnswered }: { sessionId: string; asked: Asked; onAnswered: () => void }) {
  const answer = useAnswerRequest();
  const { mayAct } = useContext(SessionContext);
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
          <span className="text-meta font-mid text-ember-ink">{ASKING[asked.kind]} {asked.detail}</span>
        </div>
        <pre className="scroll-slim mt-3 max-h-44 overflow-auto rounded-lg bg-ground/60 px-3.5 py-2.5 font-mono text-code whitespace-pre-wrap text-bone">{what(asked)}</pre>
      </div>
      {/* **Shown, never answerable, to somebody watching.** The agent has
          stopped and is asking whether it may do something it thinks is
          dangerous, on somebody else's machine. Reading the question is part
          of watching the work; deciding it is not, and the server refuses it
          either way — so a row of live buttons here would only mean a refusal
          arriving after the click. */}
      {!mayAct ? (
        <div className="mt-3 border-t border-ember-deep/40 px-5 py-3 text-meta text-mute">
          Waiting on whoever owns this work.
        </div>
      ) : explaining ? (
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
  const { mayAct } = useContext(SessionContext);
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
        <span className="text-meta font-mid text-ember-ink">{mayAct ? "Waiting on you" : "Waiting on whoever owns this work"}</span>
      </div>
      <div className="space-y-5 px-5 pt-3 pb-4">
        {asking.questions.map((q) => (
          <div key={q.question}>
            <p className="text-lede text-bone">{q.question}</p>
            <div className="mt-3 grid gap-1.5">
              {q.options.map((o) => {
                const on = (chosen[q.question] ?? []).includes(o.label);
                return (
                  <button key={o.label} disabled={!mayAct} onClick={() => pick(q.question, o.label, !!q.multiSelect)} className={`flex items-start gap-3 rounded-lg border px-3.5 py-3 text-left transition-colors duration-150 ${on ? "border-ember-deep bg-ground/80" : "border-ember-deep/50 bg-ground/50"} ${mayAct ? "hover:border-ember-deep hover:bg-ground/80" : "cursor-default"}`}>
                    <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border border-ember-deep text-micro font-mid ${on ? "bg-ember text-ground" : "bg-ember-tint text-ember-ink"}`}>{on ? <Check className="h-3 w-3" strokeWidth={3} /> : o.label[0]}</span>
                    <span className="min-w-0"><span className="block text-ui font-medium text-bone">{o.label}</span>{o.description && <span className="mt-0.5 block text-meta text-dim">{o.description}</span>}</span>
                  </button>
                );
              })}
            </div>
            {mayAct && <input value={written[q.question] ?? ""} onChange={(e) => setWritten((c) => ({ ...c, [q.question]: e.target.value }))} placeholder="Or answer in your own words" className="mt-2 w-full rounded-lg border border-ember-deep/40 bg-ground/40 px-3 py-2 text-ui text-bone placeholder:text-mute focus:border-ember-deep focus:outline-none" />}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-ember-deep/40 px-5 py-3">
        {mayAct ? (
          <>
            <button disabled={!ready} onClick={send} className="control bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute">Answer</button>
            <span className="text-micro text-mute">{asking.questions.length > 1 ? `${asking.questions.length} questions` : ""}</span>
          </>
        ) : (
          <span className="text-meta text-mute">You can read what it asked; answering is theirs.</span>
        )}
      </div>
    </div>
  );
}

/**
 * What somebody shared a look at sees instead of a composer.
 *
 * Two different people end up here and are owed different sentences. A viewer
 * has a look at the place and nothing to do but read. Somebody with writer can
 * work here — just not in *this* conversation, which runs on somebody else's
 * subscription — so the way in is an agent of their own, and the card carries
 * the button for it.
 *
 * Stated as what they have rather than as what they lack: "you are watching"
 * is a position, "you cannot type" is a complaint.
 */
function Watching({ whose, mayWorkHere, onStart }: { whose?: string | null; mayWorkHere: boolean; onStart: () => void }) {
  return (
    // As wide as the sentence and no wider, in the middle. A full-width bar
    // reads as a composer that has lost its text box; a pill reads as a note.
    <div className="flex justify-center px-3 pb-3">
      <div className="inline-flex items-center gap-2.5 rounded-full border border-line bg-panel py-2.5 pr-2.5 pl-4">
        <Eye className="h-3.5 w-3.5 shrink-0 text-mute" strokeWidth={1.75} />
        <span className="text-ui text-dim">
          {whose ? `You are watching ${whose}'s work.` : "You are watching this work."}
        </span>
        {/* The way in, for somebody who may work here but not in this
            conversation: an agent of their own, on their own subscription. */}
        {mayWorkHere && (
          <button
            onClick={onStart}
            title="A second agent in this workspace, on your own subscription"
            className="control rounded-full border border-line bg-raise text-ui text-dim hover:bg-overlay hover:text-bone"
          >
            <Bot className="h-3.5 w-3.5" strokeWidth={1.75} />Start your own agent
          </button>
        )}
      </div>
    </div>
  );
}
