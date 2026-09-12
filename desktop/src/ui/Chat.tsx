/**
 * The conversation.
 *
 * This is where people spend their time, so it is the one surface built for
 * reading rather than for operating: a single column at 15px with prose
 * line-height, the agent speaking straight onto the ground with no container
 * around it, and you on a raised card. Two speakers, told apart by weight and
 * ground rather than by two facing bubbles — a chat app arrangement, and this
 * is not a chat app: the agent's turn is long and is the thing you came to
 * read.
 *
 * Tool calls hang off a hairline to the left of the text, so a turn that
 * touched fourteen files still reads as one paragraph with work attached
 * rather than as fourteen rows of furniture.
 */
import { useState } from "react";
import {
  Check, ChevronRight, Copy, FileText, GitBranch, Pencil,
  RotateCcw, Search, Terminal,
} from "lucide-react";
import { elapsed, minutesSince } from "@/src/api/view";
import type { Workspace } from "@/src/api/workspaces";
import { Composer } from "~/ui/Composer";
import type { Ask, Diff, Tool, Turn } from "~/mock/backends";

const GLYPH: Record<string, typeof Terminal> = {
  bash: Terminal,
  read: FileText,
  grep: Search,
  edit: Pencil,
};

export function Chat({
  place,
  run,
  talk,
  onOpenDiff,
  onOpenFile,
}: {
  place: Workspace;
  /** Which agent in this workspace you are reading. */
  run: Workspace["runs"][number];
  talk: { turns: Turn[]; ask?: Ask; diffs: Diff[] };
  onOpenDiff: () => void;
  onOpenFile: (path: string, keep?: boolean) => void;
}) {
  const lead = run;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="scroll-slim min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[46rem] px-8 pt-8 pb-4">
          <h1 className="text-display text-bone">{lead.title}</h1>
          <div className="mt-2 flex items-center gap-4 text-meta text-mute">
            <span className="flex items-center gap-1.5 font-mono">
              <GitBranch className="h-3.5 w-3.5" strokeWidth={1.75} />
              {place.branch}
            </span>
            <span>started {elapsed(minutesSince(lead.createdAt))} ago</span>
          </div>

          <div className="mt-9 space-y-8">
            {talk.turns.map((turn, i) => (
              <Said key={i} turn={turn} onOpenDiff={onOpenDiff} onOpenFile={onOpenFile} />
            ))}
          </div>

          {talk.ask && <Asking ask={talk.ask} />}
        </div>
      </div>

      <Composer asking={!!talk.ask} />
    </div>
  );
}

function Said({
  turn,
  onOpenDiff,
  onOpenFile,
}: {
  turn: Turn;
  onOpenDiff: () => void;
  onOpenFile: (path: string, keep?: boolean) => void;
}) {
  if (turn.who === "you") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md border border-line bg-raise px-4 py-2.5 text-read text-text shadow-(--shadow-raise)">
          <Rich text={turn.text} />
        </div>
      </div>
    );
  }

  return (
    <div className="group/turn">
      {turn.thinking && <Thinking text={turn.thinking} />}

      <div className="text-read text-text">
        {turn.text.split("\n\n").map((p, i) => (
          <p key={i} className={i ? "mt-4" : ""}>
            <Rich text={p} />
          </p>
        ))}
      </div>

      {turn.tools && (
        <div className="mt-4 ml-px border-l border-line pl-4">
          {turn.tools.map((t, i) => (
            <ToolCall key={i} tool={t} onOpenDiff={onOpenDiff} onOpenFile={onOpenFile} />
          ))}
        </div>
      )}

      <div className="mt-3 flex gap-1 opacity-0 transition-opacity duration-150 group-hover/turn:opacity-100">
        <Action icon={Copy} label="Copy" />
        <Action icon={RotateCcw} label="Try again" />
      </div>
    </div>
  );
}

function Action({ icon: Glyph, label }: { icon: typeof Copy; label: string }) {
  return (
    <button
      title={label}
      className="grid h-7 w-7 place-items-center rounded-md text-mute transition-colors hover:bg-raise hover:text-bone"
    >
      <Glyph className="h-3.5 w-3.5" strokeWidth={1.75} />
    </button>
  );
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      onClick={() => setOpen(!open)}
      className="mb-3 flex w-full items-start gap-2 text-left text-meta text-mute transition-colors hover:text-dim"
    >
      <ChevronRight
        className={`mt-1 h-3.5 w-3.5 shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
        strokeWidth={1.75}
      />
      <span className={open ? "leading-relaxed" : ""}>{open ? text : "Thought for a moment"}</span>
    </button>
  );
}

function ToolCall({
  tool,
  onOpenDiff,
  onOpenFile,
}: {
  tool: Tool;
  onOpenDiff: () => void;
  onOpenFile: (path: string, keep?: boolean) => void;
}) {
  const Icon = GLYPH[tool.name] ?? Terminal;
  /* A call that names a file is a way into it: `read` opens the file, `edit`
     opens what changed. Reading a transcript and wanting the file it is talking
     about is the commonest thing anybody does here. */
  const file = (tool.name === "read" || tool.name === "edit") && /\.[a-z]+$/.test(tool.arg);

  return (
    <button
      onClick={file ? () => (tool.name === "edit" ? onOpenDiff() : onOpenFile(tool.arg)) : undefined}
      className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left font-mono text-code transition-colors ${
        file ? "hover:bg-raise" : "cursor-default"
      }`}
    >
      <Icon
        className={`h-3.5 w-3.5 shrink-0 ${tool.ok === false ? "text-brick" : "text-mute"}`}
        strokeWidth={1.75}
      />
      <span className="shrink-0 text-dim">{tool.name}</span>
      <span className={`min-w-0 flex-1 truncate ${file ? "text-mute underline decoration-line underline-offset-2" : "text-mute"}`}>
        {tool.arg}
      </span>
      {tool.result && (
        <span className={`shrink-0 ${tool.ok === false ? "text-brick" : "text-mute"}`}>
          {tool.result}
        </span>
      )}
    </button>
  );
}

/**
 * The one loud thing in the product.
 *
 * An agent has stopped and is waiting for a person. Everything else on screen
 * is built to stay quiet so that this can be the thing you see from across the
 * room — so it gets the ember, the pulse, and the only saturated surface in the
 * window. Nothing else is allowed to compete.
 */
function Asking({ ask }: { ask: Ask }) {
  const [answered, setAnswered] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  if (answered) {
    return (
      <div className="mt-8 flex items-center gap-2.5 text-meta text-mute">
        <Check className="h-4 w-4 text-sage" strokeWidth={2} />
        You said <span className="text-dim">{answered}</span>. The agent picked it up.
      </div>
    );
  }

  return (
    <div className="mt-8 overflow-hidden rounded-xl border border-ember-deep bg-ember-tint shadow-(--shadow-float)">
      <div className="px-5 pt-4">
        <div className="flex items-center gap-2.5">
          <span className="ember-pulse h-2 w-2 rounded-full bg-ember" />
          <span className="text-meta font-semibold text-ember-soft">Waiting on you</span>
        </div>
        <p className="mt-2.5 text-lede text-bone">{ask.question}</p>
      </div>

      {ask.options && (
        <div className="mt-4 grid gap-1.5 px-5">
          {ask.options.map(([label, why]) => (
            <button
              key={label}
              onClick={() => setAnswered(label)}
              className="flex items-start gap-3 rounded-lg border border-ember-deep/50 bg-ground/50 px-3.5 py-3 text-left transition-colors duration-150 hover:border-ember-deep hover:bg-ground/80"
            >
              <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border border-ember-deep bg-ember-tint text-micro font-semibold text-ember-soft">
                {label[0]}
              </span>
              <span className="min-w-0">
                <span className="block text-ui font-medium text-bone">{label}</span>
                <span className="mt-0.5 block text-meta text-dim">{why}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="mt-4 flex items-center gap-2 border-t border-ember-deep/40 px-5 py-3">
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && typed.trim() && setAnswered(typed.trim())}
          placeholder="Answer in your own words"
          className="min-w-0 flex-1 bg-transparent text-ui text-bone placeholder:text-mute focus:outline-none"
        />
        <button
          disabled={!typed.trim()}
          onClick={() => typed.trim() && setAnswered(typed.trim())}
          className="keycap disabled:opacity-40"
        >
          ⏎
        </button>
      </div>
    </div>
  );
}

/** Inline code, which agents write constantly. The rest of markdown is not
    what this prototype is testing. */
export function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/g).map((part, i) =>
        part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
          <code
            key={i}
            className="rounded bg-ground/80 px-1.5 py-0.5 font-mono text-code text-bone"
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
