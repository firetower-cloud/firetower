/**
 * The transcript, and the thing it is asking you.
 *
 * Follows the control plane's pattern rather than its plumbing: a turn has a
 * speaker, tool calls belong to the turn that made them, and a question stops
 * the session until somebody answers. What the event log carries — deltas, item
 * ids, subagent tasks — is what makes streaming work, not what makes the screen
 * read, so the prototype keeps the reading and skips the streaming.
 *
 * The answer block is the one place ember is allowed to be loud, because it is
 * the entire product: an agent stopped, and it is waiting for you.
 */
import { useState } from "react";
import { Check, ChevronRight, CornerDownLeft, Terminal, FileText, Search, Pencil } from "lucide-react";
import { Icon } from "@/components/ui";
import { elapsed, minutesSince } from "@/src/api/view";
import type { Workspace } from "@/src/api/workspaces";
import type { Ask, Diff, Tool, Turn } from "~/mock/backends";

const ICON: Record<string, typeof Terminal> = {
  bash: Terminal,
  read: FileText,
  grep: Search,
  edit: Pencil,
};

export function Conversation({
  place,
  talk,
}: {
  place: Workspace;
  talk: { turns: Turn[]; ask?: Ask; diffs: Diff[] };
}) {
  const lead = place.runs[0];

  return (
    <div className="scroll-slim h-full overflow-y-auto">
      <div className="mx-auto max-w-[760px] px-6 py-6">
        <header>
          <h1 className="text-display text-bone">{lead.title}</h1>
          <p className="mt-1 font-mono text-meta text-mute">
            {place.branch} · started {elapsed(minutesSince(lead.createdAt))} ago
          </p>
        </header>

        <div className="mt-6 space-y-5">
          {talk.turns.map((turn, i) => (
            <Said key={i} turn={turn} />
          ))}
        </div>

        {talk.ask && <Asking ask={talk.ask} />}

        {!talk.ask && (
          <div className="mt-6">
            <Composer />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Inline code, and nothing else.
 *
 * Agents write `path/to/file.rs` constantly and a transcript that prints the
 * backticks reads as broken. The rest of markdown is not worth pulling a parser
 * in for here — the real client renders the full thing, and what this needs to
 * establish is whether the *type* holds up at 14px in a window.
 */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/g).map((part, i) =>
        part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
          <code
            key={i}
            className="rounded-sm bg-ground/70 px-1 py-px font-mono text-code text-bone"
          >
            {part.slice(1, -1)}
          </code>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function Said({ turn }: { turn: Turn }) {
  if (turn.who === "you") {
    return (
      <div>
        <div className="eyebrow mb-1.5">You</div>
        <div className="rounded-md border border-line-soft bg-panel px-3 py-2 text-body text-text">
          <Rich text={turn.text} />
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="eyebrow mb-1.5">Agent</div>
      {turn.thinking && <Thinking text={turn.thinking} />}
      <div className="rounded-md border border-line bg-raise px-3 py-2 text-body text-text shadow-(--shadow-raise)">
        {turn.text.split("\n\n").map((p, i) => (
          <p key={i} className={i ? "mt-2.5" : ""}>
            <Rich text={p} />
          </p>
        ))}
      </div>
      {turn.tools && (
        <div className="mt-2 space-y-px">
          {turn.tools.map((t, i) => (
            <ToolCall key={i} tool={t} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Collapsed by default: it is context, not the answer. */
function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      onClick={() => setOpen(!open)}
      className="mb-1.5 flex w-full items-start gap-1.5 rounded-sm px-1 py-0.5 text-left text-meta text-mute transition-colors hover:text-dim"
    >
      <ChevronRight
        className={`mt-px h-3 w-3 shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
        strokeWidth={2}
      />
      <span className={open ? "" : "truncate"}>{open ? text : "Thought about it"}</span>
    </button>
  );
}

function ToolCall({ tool }: { tool: Tool }) {
  const Glyph = ICON[tool.name] ?? Terminal;
  return (
    <div className="flex items-center gap-2 rounded-sm px-2 py-1 font-mono text-micro hover:bg-raise/60">
      <Icon of={Glyph} size={12} className={tool.ok === false ? "text-brick" : "text-mute"} />
      <span className="text-dim">{tool.name}</span>
      <span className="min-w-0 flex-1 truncate text-mute">{tool.arg}</span>
      {tool.result && (
        <span className={tool.ok === false ? "text-brick" : "text-mute"}>{tool.result}</span>
      )}
    </div>
  );
}

/** The whole point of the product, on screen. */
function Asking({ ask }: { ask: Ask }) {
  const [answered, setAnswered] = useState<string | null>(null);

  if (answered) {
    return (
      <div className="mt-6 flex items-center gap-2 rounded-md border border-line bg-panel px-3 py-2 text-ui text-dim">
        <Icon of={Check} size={12} className="text-sage" />
        Answered — <span className="text-bone">{answered}</span>. The agent is working again.
      </div>
    );
  }

  return (
    <div className="mt-6 overflow-hidden rounded-lg border border-ember-deep bg-ember-tint shadow-(--shadow-raise)">
      <div className="flex items-center gap-2 px-4 pt-3">
        <span className="ember-pulse h-1.5 w-1.5 rounded-full bg-ember" />
        <span className="eyebrow !text-ember-soft">Waiting on you</span>
      </div>

      <p className="px-4 pt-2 text-body text-bone">{ask.question}</p>

      {ask.options && (
        <div className="mt-3 space-y-1 px-4">
          {ask.options.map(([label, why]) => (
            <button
              key={label}
              onClick={() => setAnswered(label)}
              className="flex w-full items-start gap-2.5 rounded-md border border-ember-deep/60 bg-ground/40 px-3 py-2 text-left transition-colors hover:bg-ground/70"
            >
              <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border border-ember-deep text-[9px] text-ember-soft">
                {label[0]}
              </span>
              <span className="min-w-0">
                <span className="block text-ui text-bone">{label}</span>
                <span className="block text-meta text-dim">{why}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2 border-t border-ember-deep/40 px-4 py-2.5">
        <input
          placeholder="…or answer in words"
          onKeyDown={(e) => {
            const v = (e.target as HTMLInputElement).value.trim();
            if (e.key === "Enter" && v) setAnswered(v);
          }}
          className="min-w-0 flex-1 bg-transparent text-ui text-bone placeholder:text-mute focus:outline-none"
        />
        <Icon of={CornerDownLeft} size={12} className="text-mute" />
      </div>
    </div>
  );
}

function Composer() {
  return (
    <div className="flex items-end gap-2 rounded-md border border-line bg-panel px-3 py-2">
      <textarea
        rows={1}
        placeholder="Say something to the agent"
        className="scroll-slim max-h-32 min-w-0 flex-1 resize-none bg-transparent text-body text-text placeholder:text-mute focus:outline-none"
      />
      <span className="pb-0.5 text-micro text-mute">⏎</span>
    </div>
  );
}
