/**
 * The conversation, off the stream.
 *
 * Everything drawn here comes from `useConversation` in
 * `web/src/api/conversation.ts` — the fold from lifecycle events into items,
 * requests, questions, tasks, usage and mode. That fold is the contract; this
 * file only decides how each thing looks at desk size. On a fixture backend the
 * stream is quiet and the scripted `TALK` is drawn instead, through the same
 * shapes, so the demo and the real thing are one component.
 *
 * Reading, not operating: one column at 15px with prose line-height, the agent
 * speaking straight onto the ground, you on a raised card, tool calls hanging
 * off a hairline so a turn that touched fourteen files is still one paragraph
 * with work attached.
 *
 * The approval card is the one loud thing. The agent is genuinely stopped
 * while it is up — the tool call is held open on the host — and it can sit
 * there for hours; the session picks up where it was.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Copy,
  FileText,
  GitBranch,
  Pencil,
  RotateCcw,
  Search,
  Terminal,
  X,
} from "lucide-react";
import { Icon } from "@/components/ui";
import { useConversation, type Asked, type Item, type Questionnaire } from "@/src/api/conversation";
import type { Decision, ItemKind, RequestKind, Session } from "@/src/api/generated/model";
import { useAnswerRequest, useRelaunchSession, getGetSessionQueryKey } from "@/src/api/generated/sessions/sessions";
import { useQueryClient } from "@tanstack/react-query";
import { elapsed, minutesSince } from "@/src/api/view";
import { Composer } from "~/ui/Composer";
import { isLive } from "~/mock/http";
import { talkFor, type Ask, type Turn } from "~/mock/backends";

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

export function Chat({
  session,
  branch,
  onOpenDiff,
  onOpenFile,
}: {
  session: Session;
  branch?: string;
  onOpenDiff: () => void;
  onOpenFile: (path: string, keep?: boolean) => void;
}) {
  const live = isLive();
  const { conversation, echo, settle, remember } = useConversation(session.id);
  const foot = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  /* A fixture has no stream; its scripted conversation is folded into the
     same item shape so the rest of this file does not know the difference. */
  const fixture = useMemo(() => (live ? null : fromTalk(talkFor(session.workspaceId ?? session.id))), [live, session.id, session.workspaceId]);
  const items = live ? conversation.items : fixture!.items;
  const asked = live ? conversation.asked : fixture!.asked;
  const questions = live ? conversation.questions : [];
  const working = live ? conversation.working : false;
  const stopped = live ? conversation.stopped : undefined;
  const answerable = session.status !== "Ended";

  useEffect(() => {
    if (following.current) foot.current?.scrollIntoView({ block: "end" });
  }, [items.length, working, asked.length, questions.length]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="scroll-slim min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className="mx-auto w-full max-w-[46rem] px-8 pt-8 pb-4">
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

          {items.length === 0 && !working && (
            <p className="mt-10 text-read text-mute">
              {live && conversation.trouble
                ? conversation.trouble
                : "Nothing said yet. The agent is here and waiting for you."}
            </p>
          )}

          <ol className="mt-9 space-y-7">
            {items.map((item) => (
              <Node key={item.id} item={item} onOpenDiff={onOpenDiff} onOpenFile={onOpenFile} />
            ))}
          </ol>

          {working && <Working heardAt={conversation.heardAt} />}

          {stopped && <Stopped why={stopped} />}
          {session.status === "Failed" && <Relaunch session={session} />}

          {questions.map((q) => (
            <Questions key={q.req} sessionId={session.id} asking={q} onAnswered={() => settle(q.req)} />
          ))}
          {asked.map((a) => (
            <Approval key={a.req} sessionId={session.id} asked={a} onAnswered={() => settle(a.req)} live={live} />
          ))}

          <div ref={foot} />
        </div>
      </div>

      <Composer
        session={session}
        conversation={conversation}
        onEcho={echo}
        onRemember={remember}
        disabled={!answerable}
        asking={asked.length + questions.length > 0}
      />
    </div>
  );
}

/* ── Items ─────────────────────────────────────────────────────────────── */

function Node({
  item,
  onOpenDiff,
  onOpenFile,
}: {
  item: Item;
  onOpenDiff: () => void;
  onOpenFile: (path: string, keep?: boolean) => void;
}) {
  if (item.kind === "UserMessage") {
    return (
      <li className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md border border-line bg-raise px-4 py-2.5 text-read text-text shadow-(--shadow-raise)">
          {item.images && item.images.length > 0 && (
            <div className={`flex flex-wrap gap-1.5 ${item.text ? "mb-2" : ""}`}>
              {item.images.map((image, i) => (
                <img
                  key={i}
                  src={`data:${image.mediaType};base64,${image.data}`}
                  alt=""
                  className="max-h-[200px] max-w-full rounded-md border border-line object-contain"
                />
              ))}
            </div>
          )}
          {item.text && <p className="whitespace-pre-wrap">{item.text}</p>}
        </div>
      </li>
    );
  }

  if (item.kind === "AssistantMessage") {
    return (
      <li className="group/turn">
        <div className="text-read text-text">
          {item.text.split("\n\n").map((p, i) => (
            <p key={i} className={i ? "mt-4" : ""}>
              <Rich text={p} />
            </p>
          ))}
        </div>
        <div className="mt-3 flex gap-1 opacity-0 transition-opacity duration-150 group-hover/turn:opacity-100">
          <Action icon={Copy} label="Copy" onClick={() => navigator.clipboard?.writeText(item.text)} />
        </div>
      </li>
    );
  }

  if (item.kind === "Reasoning") return <Thought item={item} />;

  return <ToolRow item={item} onOpenDiff={onOpenDiff} onOpenFile={onOpenFile} />;
}

function Action({ icon: Glyph, label, onClick }: { icon: typeof Copy; label: string; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      title={label}
      className="grid h-7 w-7 place-items-center rounded-md text-mute transition-colors hover:bg-raise hover:text-bone"
    >
      <Glyph className="h-3.5 w-3.5" strokeWidth={1.75} />
    </button>
  );
}

function Thought({ item }: { item: Item }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-start gap-2 text-left text-meta text-mute transition-colors hover:text-dim"
      >
        <ChevronRight
          className={`mt-1 h-3.5 w-3.5 shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
          strokeWidth={1.75}
        />
        <span className={open ? "leading-relaxed whitespace-pre-wrap" : ""}>
          {open ? item.text : "Thought for a moment"}
        </span>
      </button>
    </li>
  );
}

function ToolRow({
  item,
  onOpenDiff,
  onOpenFile,
}: {
  item: Item;
  onOpenDiff: () => void;
  onOpenFile: (path: string, keep?: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const failed = item.status === "Failed";
  const Glyph = GLYPH[item.kind] ?? Terminal;
  const line = said(item);
  const path = /\.[a-z0-9]+$/i.test(line) && !line.includes(" ") ? line : null;

  return (
    <li className="ml-px border-l border-line pl-4">
      <div className="flex items-center gap-2.5 rounded-md px-2 py-1.5 font-mono text-code">
        <Icon of={Glyph} size={14} className={failed ? "text-brick" : "text-mute"} />
        <button onClick={() => setOpen(!open)} className="shrink-0 text-dim hover:text-bone">
          {DID[item.kind] ?? "used"}
        </button>
        <button
          onClick={() => {
            if (item.kind === "FileChange") onOpenDiff();
            else if (path) onOpenFile(path);
            else setOpen(!open);
          }}
          className={`min-w-0 flex-1 truncate text-left ${
            failed ? "text-brick" : path ? "text-mute underline decoration-line underline-offset-2 hover:text-dim" : "text-mute"
          }`}
        >
          {line}
        </button>
        {item.status && (
          <span className={`shrink-0 text-micro ${failed ? "text-brick" : "text-mute"}`}>
            {item.status === "Completed" ? "" : item.status.toLowerCase()}
          </span>
        )}
        {!item.status && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-slate" />}
      </div>

      {open && (
        <div className="mb-1 space-y-1.5 px-2">
          {item.input !== undefined && (
            <pre className="scroll-slim max-h-40 overflow-auto rounded-md bg-panel px-3 py-2 font-mono text-micro whitespace-pre-wrap text-mute">
              {JSON.stringify(item.input, null, 2)}
            </pre>
          )}
          {item.output && (
            <pre
              className={`scroll-slim max-h-72 overflow-auto rounded-md bg-panel px-3 py-2 font-mono text-micro whitespace-pre-wrap ${
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

function Working({ heardAt }: { heardAt?: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const ago = heardAt ? Math.round((Date.now() - heardAt) / 1000) : null;
  return (
    <div className="mt-6 flex items-center gap-2.5 text-meta text-mute">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate" />
      Working{ago !== null && ago > 5 ? ` — last heard ${ago}s ago` : "…"}
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
 * The agent is not running. Its workspace, its branch and everything said so
 * far are still here — starting it again picks the conversation up where it
 * stopped. Saying what is *still there* is the point of the sentence.
 */
function Relaunch({ session }: { session: Session }) {
  const cache = useQueryClient();
  const relaunch = useRelaunchSession();
  return (
    <div className="mt-6 rounded-xl border border-ember-deep bg-panel px-4 py-3.5">
      <p className="text-ui text-text">
        The agent is not running. Its workspace, its branch and everything said so far are
        still here — starting it again picks the conversation up where it stopped.
      </p>
      {session.note && !session.note.startsWith("The agent is not running") && (
        <p className="mt-2 font-mono text-meta text-mute">{session.note}</p>
      )}
      <button
        disabled={relaunch.isPending}
        onClick={() =>
          relaunch.mutate(
            { id: session.id },
            { onSuccess: () => cache.invalidateQueries({ queryKey: getGetSessionQueryKey(session.id) }) },
          )
        }
        className="control mt-3 bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute"
      >
        <RotateCcw className="h-3.5 w-3.5" strokeWidth={2} />
        Start it again
      </button>
    </div>
  );
}

/* ── Requests ──────────────────────────────────────────────────────────── */

function Approval({
  sessionId,
  asked,
  onAnswered,
  live,
}: {
  sessionId: string;
  asked: Asked;
  onAnswered: () => void;
  live: boolean;
}) {
  const answer = useAnswerRequest();
  const [reason, setReason] = useState("");
  const [explaining, setExplaining] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const decide = (decision: Decision) => {
    setDone(decision.decision);
    onAnswered();
    if (live) answer.mutate({ id: sessionId, data: { req: asked.req, decision } });
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
          <span className="text-meta font-semibold text-ember-soft">
            {ASKING[asked.kind]} {asked.detail}
          </span>
        </div>
        <pre className="scroll-slim mt-3 max-h-44 overflow-auto rounded-lg bg-ground/60 px-3.5 py-2.5 font-mono text-code whitespace-pre-wrap text-bone">
          {what(asked)}
        </pre>
      </div>

      {explaining ? (
        <div className="mt-3 flex items-center gap-2 border-t border-ember-deep/40 px-5 py-3">
          <input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") decide({ decision: "Deny", reason: reason.trim() || null });
              if (e.key === "Escape") setExplaining(false);
            }}
            placeholder="Why not? The agent reads this."
            className="min-w-0 flex-1 bg-transparent text-ui text-bone placeholder:text-mute focus:outline-none"
          />
          <button
            onClick={() => decide({ decision: "Deny", reason: reason.trim() || null })}
            className="control border border-brick-deep text-brick hover:bg-brick-tint"
          >
            Deny
          </button>
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-2 border-t border-ember-deep/40 px-5 py-3">
          <button onClick={() => decide({ decision: "Allow" })} className="control bg-bone font-medium text-ground hover:opacity-90">
            Allow
          </button>
          <button onClick={() => decide({ decision: "AllowAlways" })} className="control border border-line text-dim hover:text-bone">
            Always
          </button>
          <button onClick={() => setExplaining(true)} className="control ml-auto border border-line text-dim hover:border-brick-deep hover:text-brick">
            Deny
          </button>
        </div>
      )}
    </div>
  );
}

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
        decision: {
          decision: "Answered",
          // Keyed by the question's own text, valued by the label — the agent
          // matches on both, so neither may be paraphrased on the way back.
          answers: Object.fromEntries(asking.questions.map((q) => [q.question, answered(q.question).join(", ")])),
        },
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
                  <button
                    key={o.label}
                    onClick={() => pick(q.question, o.label, !!q.multiSelect)}
                    className={`flex items-start gap-3 rounded-lg border px-3.5 py-3 text-left transition-colors duration-150 ${
                      on ? "border-ember-deep bg-ground/80" : "border-ember-deep/50 bg-ground/50 hover:border-ember-deep hover:bg-ground/80"
                    }`}
                  >
                    <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border border-ember-deep text-micro font-semibold ${on ? "bg-ember text-ground" : "bg-ember-tint text-ember-soft"}`}>
                      {on ? <Check className="h-3 w-3" strokeWidth={3} /> : o.label[0]}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-ui font-medium text-bone">{o.label}</span>
                      {o.description && <span className="mt-0.5 block text-meta text-dim">{o.description}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
            <input
              value={written[q.question] ?? ""}
              onChange={(e) => setWritten((c) => ({ ...c, [q.question]: e.target.value }))}
              placeholder="Or answer in your own words"
              className="mt-2 w-full rounded-lg border border-ember-deep/40 bg-ground/40 px-3 py-2 text-ui text-bone placeholder:text-mute focus:border-ember-deep focus:outline-none"
            />
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 border-t border-ember-deep/40 px-5 py-3">
        <button disabled={!ready} onClick={send} className="control bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute">
          Answer
        </button>
        <span className="text-micro text-mute">{asking.questions.length > 1 ? `${asking.questions.length} questions` : ""}</span>
      </div>
    </div>
  );
}

/* ── Fixtures, in the real shape ───────────────────────────────────────── */

function fromTalk(talk: { turns: Turn[]; ask?: Ask }): { items: Item[]; asked: Asked[] } {
  const items: Item[] = [];
  talk.turns.forEach((turn, i) => {
    if (turn.who === "you") {
      items.push({ id: `t${i}`, kind: "UserMessage", text: turn.text, output: "" });
      return;
    }
    if (turn.thinking) items.push({ id: `t${i}r`, kind: "Reasoning", text: turn.thinking, output: "" });
    items.push({ id: `t${i}a`, kind: "AssistantMessage", text: turn.text, output: "" });
    turn.tools?.forEach((tool, k) => {
      const kind: ItemKind =
        tool.name === "bash" ? "CommandExecution" : tool.name === "edit" ? "FileChange" : tool.name === "grep" ? "WebSearch" : "FileRead";
      items.push({
        id: `t${i}c${k}`,
        kind,
        title: tool.name,
        status: tool.ok === false ? "Failed" : "Completed",
        text: "",
        output: tool.result ?? "",
        input: tool.name === "bash" ? { command: tool.arg } : tool.name === "grep" ? { pattern: tool.arg } : { file_path: tool.arg },
      });
    });
  });
  const asked: Asked[] = talk.ask
    ? [{ req: "fixture", kind: "Tool", detail: "AskUserQuestion", args: { question: talk.ask.question } }]
    : [];
  return { items, asked };
}

/** Inline code, which agents write constantly. */
export function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/g).map((part, i) =>
        part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
          <code key={i} className="rounded bg-ground/80 px-1.5 py-0.5 font-mono text-code text-bone">
            {part.slice(1, -1)}
          </code>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

export { X };
