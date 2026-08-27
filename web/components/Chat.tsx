"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  useSendTurn,
  useInterruptSession,
  useAnswerRequest,
} from "@/src/api/generated/sessions/sessions";
import {
  useSessionControls,
  useChooseControl,
} from "@/src/api/generated/conversation/conversation";
import {
  useConversation,
  type Asked,
  type Item,
  type Questionnaire,
  type Task,
} from "@/src/api/conversation";
import { Markdown } from "@/components/Markdown";
import { ChatComposer } from "@/components/Composer.chat";
import type { Control } from "@/components/Settings.chat";
import { Annotatable, Drafting, Notes } from "@/components/Annotate";
import type { Draft } from "@/components/Annotate";
import { Bringup, type Line } from "@/components/Steps";
import { useNotes, asMessage, type Note } from "@/src/api/notes";
import { fold, summarise } from "@/src/api/steps";
import { useReveal } from "@/src/api/reveal";
import type {
  Attached,
  Checkout,
  Decision,
  ItemKind,
  PlanStep,
  RequestKind,
} from "@/src/api/generated/model";

/**
 * A session, as the thing that stopped and needs you.
 *
 * Not a chat log. Somebody opening this has been interrupted, and wants to see
 * where the agent got to, deal with whatever stopped it, and leave. So the
 * shape of the run is readable before any of the words are: one rail down the
 * left, everything hanging off it, and the rail ending in the answer to "what
 * is it doing".
 *
 * The vocabulary, kept everywhere below: **mono is what the machine said, sans
 * is speech, narrow is a label.**
 */
export function Chat({
  sessionId,
  live,
  branch,
  repo,
  checkouts,
  onAddRepo,
  steps = [],
}: {
  sessionId: string;
  live: boolean;
  branch?: string | null;
  repo?: string | null;
  /** Every repository this session holds. */
  checkouts?: Checkout[];
  onAddRepo?: () => void;
  /** How the workspace was built, drawn at the top of the transcript. */
  steps?: Line[];
}) {
  const { conversation, echo, settle, remember } = useConversation(sessionId, live);
  const { notes, add, drop, clear } = useNotes(sessionId);
  const send = useSendTurn();
  const interrupt = useInterruptSession();
  const controls = useSessionControls(sessionId, { query: { enabled: live } });
  const choose = useChooseControl();
  /** Clicked, and not yet confirmed by the server or by the agent. */
  const [chosen, setChosen] = useState<Record<string, string | undefined>>({});

  // What a session can be asked to change is not known when it opens: an
  // agent that lists its own models answers a moment later, and the pickers
  // are drawn from that answer. Saying which model it is running is the same
  // moment, so it is the signal to ask again — without it the model picker
  // never appears at all on the session that just started.
  const running = conversation.model;
  const askAgain = controls.refetch;
  useEffect(() => {
    if (live) askAgain();
  }, [running, live, askAgain]);
  const foot = useRef<HTMLDivElement>(null);
  /** Off while somebody has scrolled up to read something. */
  const following = useRef(true);

  /**
   * The note being written, if one is.
   *
   * Held here rather than in the message it is about, so the box can be drawn
   * outside the transcript. Inside it, focusing the box dragged the transcript
   * down to wherever the box happened to be — which for a long message is a
   * long way from what you were reading.
   */
  const [draft, setDraft] = useState<Draft | null>(null);

  const begin = useCallback((item: string, quote: string, first: string) => {
    setDraft({ item, quote, note: first });
  }, []);

  const waiting = conversation.asked.length > 0 || conversation.questions.length > 0;

  useEffect(() => {
    // Never while a note is being written. `following` usually says no anyway
    // — you scrolled up to read the thing you are annotating — but not if you
    // started the note near the bottom and then scrolled away from it.
    if (draft) return;
    if (following.current) foot.current?.scrollIntoView({ block: "end" });
  }, [conversation.items, conversation.working, draft]);

  const submit = (text: string, images: Attached[]) => {
    if (send.isPending) return;
    echo(text, images);
    send.mutate({ id: sessionId, data: { text, images } });
  };

  /**
   * Send everything written against the transcript, at once.
   *
   * An ordinary message — no new frame, no new endpoint, and the agent needs to
   * understand nothing it does not already. Whatever is in the composer goes
   * with them, so "and also, please…" is one send rather than two.
   */
  const sendNotes = useCallback(() => {
    if (send.isPending || notes.length === 0) return;
    const text = asMessage(notes);
    clear();
    echo(text, []);
    send.mutate({ id: sessionId, data: { text, images: [] } });
  }, [send, notes, clear, echo, sessionId]);

  /**
   * ⌘↵ sends the notes.
   *
   * Captured rather than bubbled, because the composer takes plain Enter and
   * would otherwise send an empty draft first. While there are notes waiting,
   * they are what the modifier means.
   */
  useEffect(() => {
    if (notes.length === 0) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      e.stopPropagation();
      sendNotes();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [notes.length, sendNotes]);

  /**
   * Change a setting.
   *
   * What that means belongs to whatever is driving the agent — a slash command
   * for the one that reads them out of its own input, a parameter on the next
   * turn for the one that does not. This used to build the command here, which
   * is what made every Codex session offer Opus and spend a turn saying so.
   */
  const set = (kind: Control["kind"], value: string) => {
    // Shown as chosen straight away. Claude Code restates the model and the
    // mode only at the start of the next turn, so waiting for that reads as
    // the click not having worked — and what comes back overwrites this, so a
    // request that was refused corrects itself.
    if (kind === "model" || kind === "mode" || kind === "effort") remember(kind, value);
    setChosen((was) => ({ ...was, [kind]: value }));

    choose.mutate(
      { id: sessionId, data: { kind, value } },
      { onSuccess: () => controls.refetch() },
    );
  };

  /**
   * The pickers this session has, with what is in force filled in.
   *
   * Two sources, and they answer for different agents. The server knows what
   * somebody chose for an agent that takes settings as parameters; the
   * transcript knows what an agent that restates them said. `chosen` is the
   * click that has not been confirmed by either yet.
   */
  const pickers: Control[] = (controls.data ?? []).map((control) => ({
    ...control,
    current:
      chosen[control.kind] ??
      control.current ??
      ({
        model: conversation.model,
        mode: conversation.mode,
        effort: conversation.effort,
      } as Record<string, string | undefined>)[control.kind],
  }));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        onScroll={(e) => {
          const box = e.currentTarget;
          following.current = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {/* A column, centred, rather than a line of text as wide as the
            window. The scroller stays full width so the bar sits at the edge
            of the pane and not in the middle of the reading. */}
        <div className="mx-auto w-full max-w-[860px] pt-1">
          <Bringup lines={steps} />

          {conversation.items.length === 0 && !conversation.trouble && steps.length === 0 && (
            <p className="py-10 text-[14px] text-mute">
              {live ? "Waiting for the agent." : "This session said nothing."}
            </p>
          )}

          {conversation.plan.length > 0 && <Plan steps={conversation.plan} />}

          <Rail
            // A subagent's steps are drawn under the delegation, not here.
            items={conversation.items.filter((item) => !item.task)}
            tasks={conversation.tasks}
            all={conversation.items}
            notes={notes}
            onBegin={begin}
            drafting={draft !== null}
            onDropNote={drop}
          />

          {/* Where the rail stops. The one place the eye goes to answer "is it
              still going?", and the reason there is no spinner anywhere else. */}
          <End working={conversation.working} waiting={waiting} />

          {conversation.trouble && (
            <p className="mt-3 font-mono text-[12.5px] text-brick">
              Lost the stream.{live ? " Reconnecting." : ""}
            </p>
          )}
        </div>

        <div ref={foot} className="h-12" />
      </div>

      {/* A column with a ceiling, so the composer is laid out first and the
          cards above it take whatever is left. Two vh caps that did not know
          about each other left the composer half off the bottom of a short
          window — the thing this bar exists to keep reachable. */}
      <div className="relative mx-auto flex max-h-[85vh] w-full max-w-[860px] shrink-0 flex-col bg-ground pt-3">
        {/* The transcript scrolls under this, so without a fade the last line
            is cut in half by the composer's top edge. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-full h-12"
          style={{
            background:
              "linear-gradient(to top, var(--color-ground), color-mix(in srgb, var(--color-ground) 0%, transparent))",
          }}
        />

        {/* The note being written. Outside the scroller on purpose — see
            `Drafting`. Above the bar that counts what is already kept, so the
            two read in the order they happen. */}
        {draft && (
          <Drafting
            draft={draft}
            onChange={(note) => setDraft({ ...draft, note })}
            onKeep={() => {
              const said = draft.note.trim();
              if (said) add(draft.item, draft.quote, said);
              setDraft(null);
              window.getSelection()?.removeAllRanges();
            }}
            onCancel={() => {
              setDraft(null);
              window.getSelection()?.removeAllRanges();
            }}
          />
        )}

        {/* Written against the transcript, waiting to go. */}
        {notes.length > 0 && (
          <div className="mb-2 flex shrink-0 items-center gap-3 rounded-[12px] border border-ember-deep bg-panel px-4 py-2.5">
            <span className="text-[13.5px] text-dim">
              {notes.length} {notes.length === 1 ? "note" : "notes"} on this conversation
            </span>
            <button
              onClick={clear}
              className="text-[12.5px] text-mute transition-colors hover:text-brick"
            >
              Discard
            </button>
            <button
              onClick={sendNotes}
              disabled={!live || send.isPending}
              title="Send them (⌘↵)"
              className="ml-auto flex min-h-[32px] items-center gap-2 rounded-[8px] bg-ember px-3.5 text-[13px] font-medium text-ground disabled:opacity-40"
            >
              Send them
              <span aria-hidden className="font-mono text-[12px] opacity-60">
                ⌘↵
              </span>
            </button>
          </div>
        )}

        {/* Above the composer: the thing to deal with before saying anything
            else, and on a phone the part a thumb already reaches.

            This is what shrinks when the bar runs out of room, so however
            many cards the agent has open, the composer below them keeps its
            full height. */}
        <div className="min-h-0 overflow-y-auto">
          {conversation.questions.map((asking) => (
            <Questions
              key={asking.req}
              sessionId={sessionId}
              asking={asking}
              onAnswered={() => settle(asking.req)}
            />
          ))}
          {conversation.asked.map((asked) => (
            <Approval
              key={asked.req}
              sessionId={sessionId}
              asked={asked}
              onAnswered={() => settle(asked.req)}
            />
          ))}
        </div>

        <div className="shrink-0">
        <ChatComposer
          sessionId={sessionId}
          live={live}
          working={conversation.working}
          commands={conversation.commands}
          controls={pickers}
          usage={conversation.usage}
          limits={conversation.limits}
          branch={branch}
          repo={repo}
          checkouts={checkouts}
          onAddRepo={onAddRepo}
          onSend={submit}
          onSet={set}
          onStop={() => interrupt.mutate({ id: sessionId })}
          failed={send.isError}
        />
        </div>
      </div>
    </div>
  );
}

/**
 * Where the transcript stops, when something is still going on there.
 *
 * Two states: working, or waiting on you. Whatever a spinner somewhere else
 * would have said, this says once — and when the session has handed back it
 * says nothing at all.
 */
function End({ working, waiting }: { working: boolean; waiting: boolean }) {
  // A grey dot for a session that has handed back is a marker for the absence
  // of anything, drawn every time nothing is happening — which is most of the
  // time. Nothing is happening, so nothing is drawn.
  if (!working && !waiting) return null;
  return (
    <div className="spine-end">
      <span className={`tip ${working && !waiting ? "breathe" : ""}`} />
    </div>
  );
}

/** One thing on the rail. */
function Node({
  item,
  tasks,
  items,
  notes = [],
  onBegin,
  drafting,
  onDropNote,
}: {
  item: Item;
  tasks: Task[];
  items: Item[];
  /** Notes written against this item, if any. */
  notes?: Note[];
  onBegin?: (item: string, quote: string, first: string) => void;
  /** Somebody is writing a note, so the selection offer stands down. */
  drafting?: boolean;
  onDropNote?: (id: string) => void;
}) {
  // The agent talking is the connective tissue between the things it did, so it
  // gets no marker. The most common thing on screen is the quietest.
  // Only what the agent said can be annotated. A note on your own message is a
  // note to yourself, and a note on a tool's output is a note about something
  // the agent did not write.
  // What somebody was asked, and what they said. Its own shape because the
  // interesting half is the answer, and a tool card puts that behind a fold.
  if (item.kind === "Question") return <Answered item={item} />;

  if (item.kind === "AssistantMessage") {
    return (
      <Says
        item={item}
        notes={notes}
        onBegin={onBegin}
        drafting={drafting}
        onDropNote={onDropNote}
      />
    );
  }

  // What somebody typed is theirs, and reads as an aside rather than as another
  // step in the run — so it gets a bubble and steps off the rail.
  if (item.kind === "UserMessage") {
    return (
      <li className="node flex justify-end">
        <div className="max-w-[80%] rounded-[18px] rounded-br-[6px] bg-raise px-4 py-3 text-body">
          {item.images && item.images.length > 0 && (
            <div className={`flex flex-wrap gap-1.5 ${item.text ? "mb-2" : ""}`}>
              {item.images.map((image, i) => (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  key={i}
                  src={`data:${image.mediaType};base64,${image.data}`}
                  alt="Attached"
                  className="max-h-[200px] max-w-full rounded-[10px] border border-line object-contain"
                />
              ))}
            </div>
          )}
          {item.text && (
            <p className="text-[15px] leading-[1.5] whitespace-pre-wrap text-bone">{item.text}</p>
          )}
        </div>
      </li>
    );
  }

  if (item.kind === "Reasoning") return <Thought item={item} />;
  if (item.kind === "SubagentCall") return <Delegated item={item} tasks={tasks} items={items} />;

  return <Tool item={item} />;
}

/**
 * The agent talking.
 *
 * Paced rather than painted, because the text does not arrive smoothly — see
 * `useReveal`, which explains why that is not something this end can fix and
 * what it does about it anyway.
 */
function Says({
  item,
  notes = [],
  onBegin,
  drafting,
  onDropNote,
}: {
  item: Item;
  notes?: Note[];
  onBegin?: (item: string, quote: string, first: string) => void;
  /** Somebody is writing a note, so the selection offer stands down. */
  drafting?: boolean;
  onDropNote?: (id: string) => void;
}) {
  const settled = item.status !== undefined;
  const text = useReveal(item.text, settled);

  const body = (
    <div className="max-w-[72ch]">
      <Markdown>{text}</Markdown>
    </div>
  );

  return (
    <li className="node">
      {/* Only once it has finished. Selecting text that is still arriving picks
          up whatever happened to be there a moment ago. */}
      {settled && onBegin ? (
        <Annotatable item={item.id} drafting={drafting ?? false} onBegin={onBegin}>
          {body}
        </Annotatable>
      ) : (
        body
      )}
      {onDropNote && <Notes notes={notes} onDrop={onDropNote} />}
    </li>
  );
}

/**
 * ○ running · ✕ refused, and nothing at all for something that worked.
 *
 * A marker beside every finished step is a column of dots saying "this
 * happened", which the line itself already says. What is worth a mark is what
 * has not finished and what went wrong — so those are the only two that get
 * one, and the eye goes straight to them.
 */
function Mark({ status }: { status?: Item["status"] }) {
  const state = !status ? "running" : status === "Failed" ? "failed" : "done";
  if (state === "done") return null;
  return (
    <span className="mark" data-state={state}>
      {state === "running" ? "○" : "✕"}
    </span>
  );
}

/**
 * The agent thinking.
 *
 * Usually empty — current models omit the text of their reasoning unless the
 * session is started asking for it — so this stays one quiet line. That it
 * stopped to think is worth showing even when what it thought is not on offer.
 */
function Thought({ item }: { item: Item }) {
  const [open, setOpen] = useState(false);
  // Nothing to show, so nothing is shown. Reasoning arrives empty on current
  // models, which meant a row saying "thought" on every turn — unreadable,
  // unactionable, and one or two of them between every real thing that
  // happened. When the text is switched on this draws itself.
  if (!item.text) return null;
  return (
    <li className="node">
      <span className="mark">·</span>
      <button onClick={() => setOpen(!open)} className="eyebrow transition-colors hover:text-dim">
        {open ? "Hide thinking" : "Thinking"}
      </button>
      {open && (
        <div className="mt-1 max-w-[74ch] text-mute">
          <Markdown>{item.text}</Markdown>
        </div>
      )}
    </li>
  );
}

/**
 * A question the agent asked, and what it was told.
 *
 * The card that took the answer lives above the composer and is gone the
 * moment it is answered — which left the answer nowhere, while the agent went
 * on to act on it. This is where it stays.
 *
 * Questions come from the tool's input, which is structured. The answers come
 * from its result, which is a sentence — so they are read out of it where that
 * works and shown as the sentence where it does not. A driver that words it
 * differently loses the arrow, not the answer.
 */
function Answered({ item }: { item: Item }) {
  const asked = (item.input as { questions?: { question: string }[] } | undefined)?.questions ?? [];
  const said = answers(item.output);

  // Nothing to line up against: no input, or a result we cannot read. Whatever
  // the agent said happened is better than nothing at all.
  if (asked.length === 0) {
    return (
      <li className="node">
        <span className="eyebrow">Asked</span>
        <p className="mt-1 max-w-[72ch] text-[13.5px] text-dim">{item.output ?? "…"}</p>
      </li>
    );
  }

  return (
    <li className="node">
      <span className="eyebrow">Asked</span>
      <ol className="mt-1.5 flex max-w-[72ch] flex-col gap-2">
        {asked.map((q) => (
          <li key={q.question}>
            <p className="text-[13.5px] text-mute">{q.question}</p>
            <p className="mt-0.5 flex gap-1.5 text-body text-text">
              <span aria-hidden className="text-ember">
                ↳
              </span>
              <span className="min-w-0">{said[q.question] ?? "—"}</span>
            </p>
          </li>
        ))}
      </ol>
    </li>
  );
}

/**
 * The answers, out of the sentence the tool reports.
 *
 * Claude Code answers with `"the question"="what was chosen"`, one pair per
 * question, inside prose. Reading the pairs out is a small guess about wording;
 * getting it wrong costs the arrow and nothing else, because the caller falls
 * back to showing the sentence.
 */
function answers(output?: string): Record<string, string> {
  if (!output) return {};
  const found: Record<string, string> = {};
  for (const [, question, answer] of output.matchAll(/"([^"]+)"\s*=\s*"([^"]*)"/g)) {
    found[question] = answer;
  }
  return found;
}

/** What a tool did, as a word rather than its name. */
const DID: Partial<Record<ItemKind, string>> = {
  CommandExecution: "ran",
  FileChange: "changed",
  FileRead: "read",
  McpToolCall: "called",
  WebSearch: "searched",
};

/**
 * A run of tool calls, folded into one row.
 *
 * Closed by default, including when something inside it failed — the summary
 * carries the mark and the count instead, so a broken command is named without
 * the group opening itself under somebody who was reading.
 *
 * The rules for what folds and what a closed one says live in `src/api/steps`,
 * where they can be tested without React.
 */
function Steps({
  items,
  tasks,
  all,
}: {
  items: Item[];
  tasks: Task[];
  all: Item[];
}) {
  const [open, setOpen] = useState(false);
  const { verb, text, failed } = summarise(items);

  return (
    <li className="node">
      <Mark status={failed > 0 ? "Failed" : "Completed"} />
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-baseline gap-2 text-left"
      >
        <span className="eyebrow shrink-0">{verb}</span>
        <span
          className={`min-w-0 flex-1 truncate text-[13px] ${
            failed > 0 ? "text-brick" : "text-dim"
          }`}
        >
          {text}
          {failed > 0 && ` · ${failed} failed`}
        </span>
        <span aria-hidden className="shrink-0 text-[11px] text-mute">
          {open ? "⌃" : "⌄"}
        </span>
      </button>

      {open && (
        <ol className="spine spine-nested mt-2 flex flex-col gap-4">
          {items.map((step) => (
            <Node key={step.id} item={step} tasks={tasks} items={all} />
          ))}
        </ol>
      )}
    </li>
  );
}

/**
 * Rows for a list of items: each on its own, or folded into runs.
 *
 * Both rails use this — the main one and a subagent's — because a delegated
 * run blots its own rail exactly the same way.
 */
function Rail({
  items,
  tasks,
  all,
  nested,
  notes,
  onBegin,
  drafting,
  onDropNote,
}: {
  items: Item[];
  tasks: Task[];
  all: Item[];
  nested?: boolean;
  notes?: Note[];
  onBegin?: (item: string, quote: string, first: string) => void;
  /** Somebody is writing a note, so the selection offer stands down. */
  drafting?: boolean;
  onDropNote?: (id: string) => void;
}) {
  return (
    <ol className={`spine flex flex-col ${nested ? "spine-nested gap-4" : "gap-5"}`}>
      {fold(items).map((row) =>
        row.type === "group" ? (
          <Steps key={row.id} items={row.items} tasks={tasks} all={all} />
        ) : (
          <Node
            key={row.item.id}
            item={row.item}
            tasks={tasks}
            items={all}
            notes={notes?.filter((n) => n.item === row.item.id)}
            onBegin={onBegin}
            drafting={drafting}
            onDropNote={onDropNote}
          />
        ),
      )}
    </ol>
  );
}

/**
 * A tool call, as one line.
 *
 * A transcript of bordered panels is a stack of boxes you have to read in order
 * to scan. Hanging a line off the rail makes the run legible at a glance and
 * keeps the detail one click away — the right way round, because most of the
 * time you are looking for the one that failed.
 */
function Tool({ item }: { item: Item }) {
  const [open, setOpen] = useState(false);
  const failed = item.status === "Failed";

  return (
    <li className="node">
      <Mark status={item.status} />
      <button onClick={() => setOpen(!open)} className="flex w-full items-baseline gap-2 text-left">
        <span className="eyebrow shrink-0">{DID[item.kind] ?? "used"}</span>
        <span
          className={`min-w-0 flex-1 truncate font-mono text-[13px] ${
            failed ? "text-brick" : "text-dim"
          }`}
        >
          {said(item)}
        </span>
      </button>

      {open && (
        <div className="mt-1.5 flex flex-col gap-1.5">
          {item.input !== undefined && (
            <pre className="overflow-x-auto rounded-[8px] bg-panel px-3 py-2.5 font-mono text-[12px] whitespace-pre-wrap text-mute">
              {JSON.stringify(item.input, null, 2)}
            </pre>
          )}
          {item.output && (
            <pre
              className={`max-h-[320px] overflow-auto rounded-[8px] bg-panel px-3 py-2.5 font-mono text-[12px] whitespace-pre-wrap ${
                failed ? "text-brick" : "text-dim"
              }`}
            >
              {item.output}
            </pre>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Work handed to a subagent.
 *
 * Its own rail, one level in. Interleaved into the main one, several voices
 * narrate over each other and it reads as though the agent you are talking to
 * did all of it.
 */
function Delegated({ item, tasks, items }: { item: Item; tasks: Task[]; items: Item[] }) {
  const [open, setOpen] = useState(false);
  const task = tasks.find((t) => t.item === item.id);
  const mine = task ? items.filter((i) => i.task === task.id) : [];

  const input = item.input as Record<string, unknown> | undefined;
  const description =
    task?.description ??
    (typeof input?.description === "string" ? input.description : undefined) ??
    "a subagent";
  const failed = task?.status === "Failed" || item.status === "Failed";

  return (
    <li className="node">
      <Mark status={failed ? "Failed" : (task?.status ?? item.status)} />
      <button onClick={() => setOpen(!open)} className="flex w-full items-baseline gap-2 text-left">
        <span className="eyebrow shrink-0">sent</span>
        <span className="min-w-0 flex-1 truncate text-[13.5px] text-dim">{description}</span>
        {task?.agent && <span className="eyebrow shrink-0">{task.agent}</span>}
      </button>

      {open && (
        <div className="mt-2">
          {mine.length > 0 && <Rail items={mine} tasks={tasks} all={items} nested />}
          {task?.summary && (
            <div className="mt-2 max-w-[74ch] border-l border-line-soft pl-3">
              <Markdown>{task.summary}</Markdown>
            </div>
          )}
          {mine.length === 0 && !task?.summary && (
            <p className="text-[12.5px] text-mute">Nothing back yet.</p>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The agent's own checklist.
 *
 * One of only two things on this screen that gets a panel, because it is the
 * only one describing the whole run rather than a moment in it.
 */
function Plan({ steps }: { steps: PlanStep[] }) {
  const done = steps.filter((s) => s.status === "Completed").length;
  return (
    <div className="mb-5 rounded-[12px] border border-line bg-panel px-4 py-3.5">
      <div className="eyebrow mb-2">
        Plan · {done} of {steps.length}
      </div>
      <ol className="flex flex-col gap-1">
        {steps.map((step, i) => (
          <li key={i} className="flex items-baseline gap-2 text-[13.5px]">
            <span
              className={`font-mono text-[11px] ${
                step.status === "Completed"
                  ? "text-sage"
                  : step.status === "InProgress"
                    ? "text-ember"
                    : "text-mute"
              }`}
            >
              {step.status === "Completed" ? "●" : step.status === "InProgress" ? "◐" : "○"}
            </span>
            <span className={step.status === "Completed" ? "text-mute" : "text-dim"}>
              {step.step}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** What the agent is asking to do, from the side of the person deciding. */
const ASKING: Record<RequestKind, string> = {
  CommandExecution: "wants to run",
  FileChange: "wants to change",
  FileRead: "wants to read",
  Tool: "wants to use",
};

/**
 * The one thing on this screen allowed to be loud.
 *
 * The agent is genuinely stopped while this is up — the tool call is held open
 * on the host — and there is no timer anywhere on that path, so it can sit here
 * for hours and the session picks up where it was.
 */
function Approval({
  sessionId,
  asked,
  onAnswered,
}: {
  sessionId: string;
  asked: Asked;
  onAnswered: () => void;
}) {
  const answer = useAnswerRequest();
  const [reason, setReason] = useState("");
  const [explaining, setExplaining] = useState(false);

  const decide = (decision: Decision) => {
    onAnswered();
    answer.mutate({ id: sessionId, data: { req: asked.req, decision } });
  };

  return (
    <div className="mb-4 rounded-[12px] border border-ember-deep bg-panel">
      <div className="px-3 pt-2.5">
        <span className="eyebrow text-ember">{ASKING[asked.kind]}</span>
      </div>

      <pre className="mx-3 mt-1.5 max-h-[180px] overflow-auto rounded-[8px] bg-ground px-3 py-2.5 font-mono text-[13px] whitespace-pre-wrap text-text">
        {what(asked)}
      </pre>

      {explaining ? (
        <div className="flex flex-wrap items-center gap-2 p-3">
          <input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") decide({ decision: "Deny", reason: reason.trim() || null });
              if (e.key === "Escape") setExplaining(false);
            }}
            placeholder="Why not? The agent reads this."
            className="min-h-[44px] min-w-[12rem] flex-1 rounded-[8px] border border-line bg-ground px-2.5 text-[13.5px] text-text placeholder:text-mute focus:border-ember focus:outline-none"
          />
          <button
            onClick={() => decide({ decision: "Deny", reason: reason.trim() || null })}
            className="min-h-[44px] rounded-[8px] border border-brick px-3.5 text-[13px] text-brick"
          >
            Deny
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 p-3">
          <button
            onClick={() => decide({ decision: "Allow" })}
            className="min-h-[44px] flex-1 rounded-[8px] bg-ember px-4 text-[13.5px] font-medium text-ground sm:flex-none"
          >
            Allow
          </button>
          <button
            onClick={() => decide({ decision: "AllowAlways" })}
            className="min-h-[44px] rounded-[8px] border border-line px-3.5 text-[13.5px] text-dim transition-colors hover:text-bone"
          >
            Always
          </button>
          <button
            onClick={() => setExplaining(true)}
            className="ml-auto min-h-[44px] rounded-[8px] border border-line px-3.5 text-[13.5px] text-dim transition-colors hover:border-brick hover:text-brick"
          >
            Deny
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * A question the agent asked, with its options.
 *
 * Buttons rather than a permission card: it did not ask whether it may do
 * something, it asked which of several things to do, and "allow" is not an
 * answer to that.
 *
 * ## There is always a way to say something else
 *
 * The options are the agent's guesses, and a set of guesses that happens to
 * miss used to leave somebody stuck: the card blocks the session, and nothing
 * on it could be pressed. So every question carries a way to answer in your own
 * words, which is what a person would do if this were a conversation — which it
 * is.
 */
function Questions({
  sessionId,
  asking,
  onAnswered,
}: {
  sessionId: string;
  asking: Questionnaire;
  onAnswered: () => void;
}) {
  const answer = useAnswerRequest();
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  /** What has been typed instead. Absent means the box is not open. */
  const [written, setWritten] = useState<Record<string, string | undefined>>({});

  const pick = (question: string, label: string, many: boolean) => {
    setChosen((current) => {
      const had = current[question] ?? [];
      if (!many) return { ...current, [question]: [label] };
      return {
        ...current,
        [question]: had.includes(label) ? had.filter((l) => l !== label) : [...had, label],
      };
    });
    // On a pick-one question, choosing an option is choosing it instead of
    // whatever was being typed.
    if (!many) setWritten((current) => ({ ...current, [question]: undefined }));
  };

  const say = (question: string, text: string, many: boolean) => {
    setWritten((current) => ({ ...current, [question]: text }));
    if (!many) setChosen((current) => ({ ...current, [question]: [] }));
  };

  /** Everything that would be sent for one question — options and own words. */
  const answered = (question: string): string[] => {
    const own = written[question]?.trim();
    const picked = chosen[question] ?? [];
    return own ? [...picked, own] : picked;
  };

  const ready = asking.questions.every((q) => answered(q.question).length > 0);

  const send = () => {
    onAnswered();
    answer.mutate({
      id: sessionId,
      data: {
        req: asking.req,
        decision: {
          decision: "Answered",
          answers: Object.fromEntries(
            asking.questions.map((q) => [q.question, answered(q.question).join(", ")]),
          ),
        },
      },
    });
  };

  return (
    // ⌘↵ answers, from anywhere inside the card — which is where the cursor is
    // once somebody has picked an option or started typing one. Scoped to the
    // card rather than the window so it cannot fire for a question nobody is
    // looking at.
    <div
      onKeyDown={(e) => {
        if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || !ready) return;
        e.preventDefault();
        send();
      }}
      className="mb-4 flex max-h-[60vh] flex-col rounded-[12px] border border-ember-deep bg-panel p-4"
    >
      {/* The questions scroll; the button below them does not. Three questions
          with described options is taller than a laptop screen, and this card
          sits in the bar above the composer rather than in the transcript — so
          without a ceiling it grew past the bottom of the window, taking the
          composer and its own Answer button with it, and nothing on the page
          could scroll to reach them. */}
      <div className="min-h-0 overflow-y-auto">
      {asking.questions.map((q) => {
        const picked = chosen[q.question] ?? [];
        const mine = written[q.question];
        return (
          <div key={q.question} className="mb-3 last:mb-2">
            <div className="flex items-baseline gap-2">
              <span className="eyebrow text-ember">{q.header}</span>
              {q.multiSelect && <span className="eyebrow">any</span>}
            </div>
            <p className="mt-1 mb-2 text-[14px] text-text">{q.question}</p>

            <div className="flex flex-col gap-1.5">
              {q.options.map((option) => {
                const on = picked.includes(option.label);
                return (
                  <button
                    key={option.label}
                    onClick={() => pick(q.question, option.label, q.multiSelect ?? false)}
                    className={`min-h-[44px] rounded-[8px] border px-3 py-2 text-left transition-colors ${
                      on ? "border-ember bg-raise" : "border-line hover:border-mute"
                    }`}
                  >
                    <span className={`block text-[13.5px] ${on ? "text-bone" : "text-text"}`}>
                      {option.label}
                    </span>
                    {option.description && (
                      <span className="block text-[12.5px] text-mute">{option.description}</span>
                    )}
                  </button>
                );
              })}

              {/* Last, and quieter than the options: it is the way out, not the
                  expected answer. */}
              {mine === undefined ? (
                <button
                  onClick={() => say(q.question, "", q.multiSelect ?? false)}
                  className="min-h-[44px] rounded-[8px] border border-dashed border-line px-3 py-2 text-left text-[13.5px] text-mute transition-colors hover:border-mute hover:text-text"
                >
                  Something else…
                </button>
              ) : (
                <div className="rounded-[8px] border border-ember bg-raise px-3 py-2">
                  <input
                    autoFocus
                    value={mine}
                    onChange={(e) => say(q.question, e.target.value, q.multiSelect ?? false)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setWritten((current) => ({ ...current, [q.question]: undefined }));
                      }
                    }}
                    placeholder="Say what instead"
                    className="min-h-[28px] w-full bg-transparent text-[13.5px] text-bone placeholder:text-mute focus:outline-none"
                  />
                </div>
              )}
            </div>
          </div>
        );
      })}

      </div>

      <button
        onClick={send}
        disabled={!ready}
        title="Answer (⌘↵)"
        className="mt-3 flex min-h-[44px] w-full shrink-0 items-center justify-center gap-2 rounded-[8px] bg-ember px-4 text-[13.5px] font-medium text-ground disabled:opacity-40 sm:w-auto"
      >
        Answer
        <span aria-hidden className="font-mono text-[12px] opacity-60">
          ⌘↵
        </span>
      </button>
    </div>
  );
}

/**
 * The line worth reading without opening the card.
 *
 * Whichever argument actually says what happened — the command for a shell
 * call, the path for a file. Falls back to the tool's own name, which is all
 * there is for something nobody has taught this about, and still better than
 * nothing.
 */
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
