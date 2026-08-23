"use client";

import { useEffect, useRef, useState } from "react";
import {
  useSendTurn,
  useInterruptSession,
  useAnswerRequest,
} from "@/src/api/generated/sessions/sessions";
import {
  useConversation,
  type Asked,
  type Item,
  type Questionnaire,
  type Task,
} from "@/src/api/conversation";
import { Markdown } from "@/components/Markdown";
import { ChatComposer } from "@/components/Composer.chat";
import { useReveal } from "@/src/api/reveal";
import type {
  Attached,
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
}: {
  sessionId: string;
  live: boolean;
  branch?: string | null;
  repo?: string | null;
}) {
  const { conversation, echo, settle } = useConversation(sessionId, live);
  const send = useSendTurn();
  const interrupt = useInterruptSession();
  const foot = useRef<HTMLDivElement>(null);
  /** Off while somebody has scrolled up to read something. */
  const following = useRef(true);

  const waiting = conversation.asked.length > 0 || conversation.questions.length > 0;

  useEffect(() => {
    if (following.current) foot.current?.scrollIntoView({ block: "end" });
  }, [conversation.items, conversation.working]);

  const submit = (text: string, images: Attached[]) => {
    if (send.isPending) return;
    echo(text || "(image)");
    send.mutate({ id: sessionId, data: { text, images } });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        onScroll={(e) => {
          const box = e.currentTarget;
          following.current = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {conversation.items.length === 0 && !conversation.trouble && (
          <p className="py-10 text-[13px] text-mute">
            {live ? "Waiting for the agent." : "This session said nothing."}
          </p>
        )}

        {conversation.plan.length > 0 && <Plan steps={conversation.plan} />}

        <ol className="spine flex flex-col gap-2.5">
          {conversation.items
            // A subagent's steps are drawn under the delegation, not here.
            .filter((item) => !item.task)
            .map((item) => (
              <Node
                key={item.id}
                item={item}
                tasks={conversation.tasks}
                items={conversation.items}
              />
            ))}
        </ol>

        {/* Where the rail stops. The one place the eye goes to answer "is it
            still going?", and the reason there is no spinner anywhere else. */}
        <End working={conversation.working} waiting={waiting} live={live} />

        {conversation.trouble && (
          <p className="mt-3 font-mono text-[11.5px] text-brick">
            Lost the stream.{live ? " Reconnecting." : ""}
          </p>
        )}

        <div ref={foot} />
      </div>

      <div className="shrink-0 pt-3">
        {/* Above the composer: the thing to deal with before saying anything
            else, and on a phone the part a thumb already reaches. */}
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

        <ChatComposer
          sessionId={sessionId}
          live={live}
          working={conversation.working}
          commands={conversation.commands}
          model={conversation.model}
          usage={conversation.usage}
          branch={branch}
          repo={repo}
          onSend={submit}
          onStop={() => interrupt.mutate({ id: sessionId })}
          failed={send.isError}
        />
      </div>
    </div>
  );
}

/**
 * The end of the rail.
 *
 * Three states and no others: working, waiting on you, or handed back. Whatever
 * a spinner somewhere else would have said, this says once.
 */
function End({ working, waiting, live }: { working: boolean; waiting: boolean; live: boolean }) {
  if (!live && !waiting) return <div className="spine-end" />;
  return (
    <div className="spine-end">
      <span
        className={`tip ${working && !waiting ? "breathe" : ""}`}
        style={waiting || working ? undefined : { background: "var(--color-line)" }}
      />
    </div>
  );
}

/** One thing on the rail. */
function Node({ item, tasks, items }: { item: Item; tasks: Task[]; items: Item[] }) {
  // The agent talking is the connective tissue between the things it did, so it
  // gets no marker. The most common thing on screen is the quietest.
  if (item.kind === "AssistantMessage") return <Says item={item} />;

  // What somebody typed is theirs, and reads as an aside rather than as another
  // step in the run — so it gets a bubble and steps off the rail.
  if (item.kind === "UserMessage") {
    return (
      <li className="node flex justify-end">
        <div className="max-w-[80%] rounded-[12px] rounded-br-[4px] bg-raise px-3 py-2">
          <p className="text-[13.5px] leading-[1.5] whitespace-pre-wrap text-bone">{item.text}</p>
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
function Says({ item }: { item: Item }) {
  const text = useReveal(item.text, item.status !== undefined);
  return (
    <li className="node">
      <div className="max-w-[74ch]">
        <Markdown>{text}</Markdown>
      </div>
    </li>
  );
}

/** ○ running · ● done · ✕ refused. State, and nothing else. */
function Mark({ status }: { status?: Item["status"] }) {
  const state = !status ? "running" : status === "Failed" ? "failed" : "done";
  return (
    <span className="mark" data-state={state}>
      {state === "running" ? "○" : state === "failed" ? "✕" : "●"}
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

/** What a tool did, as a word rather than its name. */
const DID: Partial<Record<ItemKind, string>> = {
  CommandExecution: "ran",
  FileChange: "changed",
  FileRead: "read",
  McpToolCall: "called",
  WebSearch: "searched",
};

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
          className={`min-w-0 flex-1 truncate font-mono text-[12px] ${
            failed ? "text-brick" : "text-dim"
          }`}
        >
          {said(item)}
        </span>
      </button>

      {open && (
        <div className="mt-1.5 flex flex-col gap-1.5">
          {item.input !== undefined && (
            <pre className="overflow-x-auto rounded-[4px] bg-panel px-2.5 py-2 font-mono text-[11px] whitespace-pre-wrap text-mute">
              {JSON.stringify(item.input, null, 2)}
            </pre>
          )}
          {item.output && (
            <pre
              className={`max-h-[320px] overflow-auto rounded-[4px] bg-panel px-2.5 py-2 font-mono text-[11px] whitespace-pre-wrap ${
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
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-dim">{description}</span>
        {task?.agent && <span className="eyebrow shrink-0">{task.agent}</span>}
      </button>

      {open && (
        <div className="mt-2">
          {mine.length > 0 && (
            <ol className="spine spine-nested flex flex-col gap-2">
              {mine.map((step) => (
                <Node key={step.id} item={step} tasks={tasks} items={items} />
              ))}
            </ol>
          )}
          {task?.summary && (
            <div className="mt-2 max-w-[74ch] border-l border-line-soft pl-3">
              <Markdown>{task.summary}</Markdown>
            </div>
          )}
          {mine.length === 0 && !task?.summary && (
            <p className="text-[11.5px] text-mute">Nothing back yet.</p>
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
    <div className="mb-4 rounded-[6px] border border-line bg-panel px-3 py-2.5">
      <div className="eyebrow mb-2">
        Plan · {done} of {steps.length}
      </div>
      <ol className="flex flex-col gap-1">
        {steps.map((step, i) => (
          <li key={i} className="flex items-baseline gap-2 text-[12.5px]">
            <span
              className={`font-mono text-[10px] ${
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
    <div className="mb-3 rounded-[6px] border border-ember-deep bg-panel">
      <div className="px-3 pt-2.5">
        <span className="eyebrow text-ember">{ASKING[asked.kind]}</span>
      </div>

      <pre className="mx-3 mt-1.5 max-h-[180px] overflow-auto rounded-[4px] bg-ground px-2.5 py-2 font-mono text-[12px] whitespace-pre-wrap text-text">
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
            className="min-h-[44px] min-w-[12rem] flex-1 rounded-[5px] border border-line bg-ground px-2.5 text-[12.5px] text-text placeholder:text-mute focus:border-ember focus:outline-none"
          />
          <button
            onClick={() => decide({ decision: "Deny", reason: reason.trim() || null })}
            className="min-h-[44px] rounded-[5px] border border-brick px-3.5 text-[12px] text-brick"
          >
            Deny
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 p-3">
          <button
            onClick={() => decide({ decision: "Allow" })}
            className="min-h-[44px] flex-1 rounded-[5px] bg-ember px-4 text-[12.5px] font-medium text-ground sm:flex-none"
          >
            Allow
          </button>
          <button
            onClick={() => decide({ decision: "AllowAlways" })}
            className="min-h-[44px] rounded-[5px] border border-line px-3.5 text-[12.5px] text-dim transition-colors hover:text-bone"
          >
            Always
          </button>
          <button
            onClick={() => setExplaining(true)}
            className="ml-auto min-h-[44px] rounded-[5px] border border-line px-3.5 text-[12.5px] text-dim transition-colors hover:border-brick hover:text-brick"
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

  const pick = (question: string, label: string, many: boolean) => {
    setChosen((current) => {
      const had = current[question] ?? [];
      if (!many) return { ...current, [question]: [label] };
      return {
        ...current,
        [question]: had.includes(label) ? had.filter((l) => l !== label) : [...had, label],
      };
    });
  };

  const ready = asking.questions.every((q) => (chosen[q.question] ?? []).length > 0);

  const send = () => {
    onAnswered();
    answer.mutate({
      id: sessionId,
      data: {
        req: asking.req,
        decision: {
          decision: "Answered",
          answers: Object.fromEntries(
            Object.entries(chosen).map(([question, labels]) => [question, labels.join(", ")]),
          ),
        },
      },
    });
  };

  return (
    <div className="mb-3 rounded-[6px] border border-ember-deep bg-panel p-3">
      {asking.questions.map((q) => {
        const picked = chosen[q.question] ?? [];
        return (
          <div key={q.question} className="mb-3 last:mb-2">
            <div className="flex items-baseline gap-2">
              <span className="eyebrow text-ember">{q.header}</span>
              {q.multiSelect && <span className="eyebrow">any</span>}
            </div>
            <p className="mt-1 mb-2 text-[13px] text-text">{q.question}</p>

            <div className="flex flex-col gap-1.5">
              {q.options.map((option) => {
                const on = picked.includes(option.label);
                return (
                  <button
                    key={option.label}
                    onClick={() => pick(q.question, option.label, q.multiSelect ?? false)}
                    className={`min-h-[44px] rounded-[5px] border px-2.5 py-1.5 text-left transition-colors ${
                      on ? "border-ember bg-raise" : "border-line hover:border-mute"
                    }`}
                  >
                    <span className={`block text-[12.5px] ${on ? "text-bone" : "text-text"}`}>
                      {option.label}
                    </span>
                    {option.description && (
                      <span className="block text-[11.5px] text-mute">{option.description}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      <button
        onClick={send}
        disabled={!ready}
        className="min-h-[44px] w-full rounded-[5px] bg-ember px-4 text-[12.5px] font-medium text-ground disabled:opacity-40 sm:w-auto"
      >
        Answer
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
