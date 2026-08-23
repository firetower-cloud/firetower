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
import type { Decision, ItemKind, PlanStep, RequestKind } from "@/src/api/generated/model";

/**
 * The agent's side of a session, as a conversation.
 *
 * Not a terminal. What the agent said, what it ran, and what it is waiting for
 * are separate things here rather than one screen of bytes — which is what
 * makes them answerable from a phone, and what lets the composer take a
 * message instead of keystrokes that can arrive while nothing is listening.
 */
export function Chat({ sessionId, live }: { sessionId: string; live: boolean }) {
  const { conversation, echo, settle } = useConversation(sessionId, live);
  const send = useSendTurn();
  const interrupt = useInterruptSession();
  const [draft, setDraft] = useState("");
  const foot = useRef<HTMLDivElement>(null);
  /** Off while somebody has scrolled up to read something. */
  const following = useRef(true);

  useEffect(() => {
    if (following.current) foot.current?.scrollIntoView({ block: "end" });
  }, [conversation.items, conversation.working]);

  const submit = () => {
    const text = draft.trim();
    if (!text || send.isPending) return;
    setDraft("");
    echo(text);
    send.mutate({ id: sessionId, data: { text } });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        onScroll={(e) => {
          const box = e.currentTarget;
          // Anchored to the bottom unless somebody has deliberately left it.
          following.current = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto pr-1"
      >
        {conversation.items.length === 0 && !conversation.trouble && (
          <p className="py-8 text-center text-[13px] text-mute">
            {live ? "Waiting for the agent…" : "Nothing was said in this session."}
          </p>
        )}

        {conversation.plan.length > 0 && <Plan steps={conversation.plan} />}

        <ol className="flex flex-col gap-3">
          {conversation.items
            // A subagent's work belongs to the subagent, and is drawn under it
            // rather than here. Interleaved, several voices narrate over each
            // other and it reads as though the agent you are talking to did
            // all of it.
            .filter((item) => !item.task)
            .map((item) => (
              <li key={item.id}>
                {item.kind === "SubagentCall" ? (
                  <Delegated
                    item={item}
                    tasks={conversation.tasks}
                    items={conversation.items}
                  />
                ) : (
                  <Entry item={item} />
                )}
              </li>
            ))}
        </ol>

        {conversation.working && (
          <p className="mt-3 text-[12px] text-mute">
            <span className="animate-pulse">●</span> working
          </p>
        )}

        {conversation.trouble && (
          <p className="mt-3 text-[12px] text-brick">
            Lost the conversation stream. {live ? "Trying again…" : ""}
          </p>
        )}

        <div ref={foot} />
      </div>

      <div className="mt-3 border-t border-line pt-3">
        {/* Above the composer, because it is the thing to deal with before
            saying anything else — and because on a phone that is where a
            thumb already is. */}
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

        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends; a newline needs a modifier. This is a message box,
              // not an editor.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={2}
            placeholder={live ? "Say something to the agent…" : "This session has finished."}
            disabled={!live}
            className="min-h-[46px] flex-1 resize-none rounded-[6px] border border-line bg-panel px-3 py-2 text-[13.5px] text-text placeholder:text-mute focus:border-ember focus:outline-none disabled:opacity-50"
          />
          {conversation.working ? (
            <button
              onClick={() => interrupt.mutate({ id: sessionId })}
              className="rounded-[6px] border border-line px-3 py-2 text-[12.5px] text-dim transition-colors hover:border-brick hover:text-brick"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!live || !draft.trim() || send.isPending}
              className="rounded-[6px] bg-ember px-3 py-2 text-[12.5px] font-medium text-ground transition-opacity disabled:opacity-40"
            >
              Send
            </button>
          )}
        </div>
        {send.isError && (
          <p className="mt-1.5 text-[11.5px] text-brick">
            That didn&apos;t reach the agent. It may have stopped.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Work handed to a subagent.
 *
 * Drawn in the transcript where the delegation happened, because that is where
 * it belongs in the story — but folded, because a subagent's tool calls are
 * its own business until somebody asks.
 *
 * The tool call and the task are separate things that arrive separately: the
 * agent asks for a subagent, and the runtime reports one starting. They are
 * matched here by the tool call's id, which is what the runtime names when it
 * reports the task.
 */
function Delegated({
  item,
  tasks,
  items,
}: {
  item: Item;
  tasks: Task[];
  items: Item[];
}) {
  const [open, setOpen] = useState(false);
  const task = tasks.find((t) => t.item === item.id);
  const mine = task ? items.filter((i) => i.task === task.id) : [];

  const description =
    task?.description ??
    (typeof (item.input as Record<string, unknown> | undefined)?.description === "string"
      ? ((item.input as Record<string, string>).description)
      : undefined) ??
    "a subagent";

  const done = task?.status === "Completed";
  const failed = task?.status === "Failed" || item.status === "Failed";

  return (
    <div className="rounded-[6px] border border-line bg-panel">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-baseline gap-2 px-3 py-2 text-left"
      >
        <span className={`font-mono text-[11px] ${failed ? "text-brick" : "text-slate"}`}>
          delegated
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-dim">{description}</span>
        {task?.agent && (
          <span className="rounded-[3px] border border-line px-1 font-mono text-[10px] text-mute">
            {task.agent}
          </span>
        )}
        <span className="text-[11px] text-mute">
          {failed ? "failed" : done ? `${mine.length}` : (task?.progress ?? "…")}
        </span>
      </button>

      {open && (
        <div className="border-t border-line-soft px-3 py-2">
          {mine.length === 0 && !task?.summary && (
            <p className="text-[11.5px] text-mute">Nothing reported back yet.</p>
          )}
          {mine.length > 0 && (
            <ol className="mb-2 flex flex-col gap-2 border-l border-line pl-3">
              {mine.map((step) => (
                <li key={step.id}>
                  <Entry item={step} />
                </li>
              ))}
            </ol>
          )}
          {task?.summary && (
            <div className="max-w-[75ch]">
              <Markdown>{task.summary}</Markdown>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A question the agent asked, with its options.
 *
 * Buttons rather than a permission card, because the agent did not ask whether
 * it may do something — it asked which of several things to do, and "allow" is
 * not an answer to that.
 *
 * The answer is keyed by the question's own text and valued by the chosen
 * option's label. Both are matched by the agent, so neither is paraphrased on
 * the way back.
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
        [question]: had.includes(label)
          ? had.filter((l) => l !== label)
          : [...had, label],
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
          // A single choice is its label; several are joined, which is the
          // shape the agent reads either way.
          answers: Object.fromEntries(
            Object.entries(chosen).map(([question, labels]) => [
              question,
              labels.length === 1 ? labels[0] : labels.join(", "),
            ]),
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
          <div key={q.question} className="mb-3 last:mb-0">
            <div className="flex items-baseline gap-2">
              <span className="text-[11px] text-ember">{q.header}</span>
              {q.multiSelect && (
                <span className="text-[10.5px] text-mute">pick any</span>
              )}
            </div>
            <p className="mt-0.5 mb-2 text-[13px] text-text">{q.question}</p>

            <div className="flex flex-col gap-1.5">
              {q.options.map((option) => {
                const on = picked.includes(option.label);
                return (
                  <button
                    key={option.label}
                    onClick={() => pick(q.question, option.label, q.multiSelect ?? false)}
                    className={`rounded-[5px] border px-2.5 py-1.5 text-left transition-colors ${
                      on
                        ? "border-ember bg-raise"
                        : "border-line hover:border-mute"
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
        className="mt-1 rounded-[5px] bg-ember px-3 py-1.5 text-[12px] font-medium text-ground disabled:opacity-40"
      >
        Answer
      </button>
    </div>
  );
}

/** What the agent is asking to do, in words rather than a tool name. */
const ASKING: Record<RequestKind, string> = {
  CommandExecution: "wants to run",
  FileChange: "wants to change",
  FileRead: "wants to read",
  Tool: "wants to use",
};

/**
 * A question the agent has stopped for.
 *
 * The agent is genuinely blocked while this is on screen — the tool call is
 * held open on the host, waiting. There is no timer anywhere on that path, so
 * this can sit here for hours and the session picks up exactly where it was.
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
    <div className="mb-3 rounded-[6px] border border-ember-deep bg-panel p-3">
      <div className="flex items-baseline gap-2">
        <span className="text-[12px] text-ember">{ASKING[asked.kind]}</span>
        <span className="font-mono text-[11px] text-mute">{asked.detail}</span>
      </div>

      <pre className="mt-2 max-h-[160px] overflow-auto rounded-[4px] bg-ground px-2.5 py-2 font-mono text-[11.5px] whitespace-pre-wrap text-text">
        {what(asked)}
      </pre>

      {explaining ? (
        <div className="mt-2 flex items-end gap-2">
          <input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") decide({ decision: "Deny", reason: reason.trim() || null });
              if (e.key === "Escape") setExplaining(false);
            }}
            placeholder="Why not? The agent reads this."
            className="flex-1 rounded-[5px] border border-line bg-ground px-2.5 py-1.5 text-[12.5px] text-text placeholder:text-mute focus:border-ember focus:outline-none"
          />
          <button
            onClick={() => decide({ decision: "Deny", reason: reason.trim() || null })}
            className="rounded-[5px] border border-brick px-2.5 py-1.5 text-[12px] text-brick"
          >
            Deny
          </button>
        </div>
      ) : (
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => decide({ decision: "Allow" })}
            className="rounded-[5px] bg-ember px-3 py-1.5 text-[12px] font-medium text-ground"
          >
            Allow
          </button>
          <button
            onClick={() => decide({ decision: "AllowAlways" })}
            className="rounded-[5px] border border-line px-3 py-1.5 text-[12px] text-dim transition-colors hover:text-bone"
          >
            Always
          </button>
          <button
            onClick={() => setExplaining(true)}
            className="ml-auto rounded-[5px] border border-line px-3 py-1.5 text-[12px] text-dim transition-colors hover:border-brick hover:text-brick"
          >
            Deny
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The part of a request worth reading before deciding.
 *
 * The command for a shell call, the path for a file. Falls back to the whole
 * input, which is all there is for a tool nobody has taught this about — and
 * showing that is still better than asking somebody to approve a name.
 */
function what(asked: Asked): string {
  const args = asked.args as Record<string, unknown> | undefined;
  for (const key of ["command", "file_path", "path", "pattern", "url"]) {
    const value = args?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return JSON.stringify(asked.args ?? {}, null, 2);
}

/** The agent's own checklist, when it is keeping one. */
function Plan({ steps }: { steps: PlanStep[] }) {
  const done = steps.filter((s) => s.status === "Completed").length;
  return (
    <div className="mb-3 rounded-[6px] border border-line bg-panel p-3">
      <div className="eyebrow mb-2">
        Plan · {done}/{steps.length}
      </div>
      <ol className="flex flex-col gap-1">
        {steps.map((step, i) => (
          <li key={i} className="flex items-baseline gap-2 text-[12.5px]">
            <span
              className={
                step.status === "Completed"
                  ? "text-sage"
                  : step.status === "InProgress"
                    ? "text-ember"
                    : "text-mute"
              }
            >
              {step.status === "Completed" ? "✓" : step.status === "InProgress" ? "▸" : "·"}
            </span>
            <span className={step.status === "Completed" ? "text-mute line-through" : "text-dim"}>
              {step.step}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** One thing in the transcript, drawn as whatever it is. */
function Entry({ item }: { item: Item }) {
  switch (item.kind) {
    case "UserMessage":
      return (
        <div className="ml-auto max-w-[85%] rounded-[6px] border border-ember-deep bg-raise px-3 py-2">
          <p className="whitespace-pre-wrap text-[13.5px] text-bone">{item.text}</p>
        </div>
      );

    case "AssistantMessage":
      return (
        <div className="max-w-[75ch]">
          <Markdown>{item.text}</Markdown>
        </div>
      );

    case "Reasoning":
      return <Reasoning item={item} />;

    default:
      return <Tool item={item} />;
  }
}

/**
 * The agent thinking.
 *
 * Folded away by default, and empty more often than not: current models omit
 * the text of their reasoning unless the session is started asking for it. The
 * card still earns its place — that the agent stopped to think is worth seeing
 * even when what it thought is not on offer.
 */
function Reasoning({ item }: { item: Item }) {
  const [open, setOpen] = useState(false);
  if (!item.text) {
    return <p className="text-[12px] text-mute italic">thought about it</p>;
  }
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="text-[12px] text-mute transition-colors hover:text-dim"
      >
        {open ? "▾" : "▸"} thinking
      </button>
      {open && (
        <div className="mt-1 max-w-[75ch] border-l border-line pl-3 text-mute">
          <Markdown>{item.text}</Markdown>
        </div>
      )}
    </div>
  );
}

/** What a tool call is called on screen, before its arguments arrive. */
const WHAT: Partial<Record<ItemKind, string>> = {
  CommandExecution: "ran",
  FileChange: "changed",
  FileRead: "read",
  McpToolCall: "called",
  WebSearch: "searched",
  SubagentCall: "delegated",
};

/**
 * A tool call.
 *
 * One card for every kind, including the ones we have no shape for — an
 * unrecognised tool still shows its name, what it was given and what it said,
 * which is why guessing at tool names is safe. A wrong guess costs a nicer
 * card, never the card.
 */
function Tool({ item }: { item: Item }) {
  const [open, setOpen] = useState(false);
  const failed = item.status === "Failed";

  return (
    <div className="rounded-[6px] border border-line bg-panel">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-baseline gap-2 px-3 py-2 text-left"
      >
        <span className={`font-mono text-[11px] ${failed ? "text-brick" : "text-slate"}`}>
          {WHAT[item.kind] ?? "used"}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-dim">
          {summary(item)}
        </span>
        <span className="text-[11px] text-mute">
          {item.status ? (failed ? "failed" : "") : "…"}
        </span>
      </button>

      {open && (
        <div className="border-t border-line-soft px-3 py-2">
          {item.input !== undefined && (
            <pre className="overflow-x-auto font-mono text-[11px] whitespace-pre-wrap text-mute">
              {JSON.stringify(item.input, null, 2)}
            </pre>
          )}
          {item.output && (
            <pre
              className={`mt-2 max-h-[300px] overflow-auto font-mono text-[11px] whitespace-pre-wrap ${
                failed ? "text-brick" : "text-dim"
              }`}
            >
              {item.output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The one line worth reading without opening the card.
 *
 * Pulled from whichever argument actually says what happened — the command for
 * a shell call, the path for a file. Falls back to the tool's own name, which
 * is all there is for something we have never seen.
 */
function summary(item: Item): string {
  const input = item.input as Record<string, unknown> | undefined;
  const first = (...keys: string[]) => {
    for (const key of keys) {
      const value = input?.[key];
      if (typeof value === "string" && value.trim()) return value;
    }
    return undefined;
  };

  return (
    first("command", "file_path", "path", "pattern", "query", "description", "prompt") ??
    item.title ??
    "…"
  );
}
