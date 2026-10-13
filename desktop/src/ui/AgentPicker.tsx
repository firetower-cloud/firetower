/**
 * What the next turn will be answered by, in one control.
 *
 * The composer used to spend a button on every setting the agent reported —
 * three for Claude Code, four for Codex — beside the paperclip, the microphone,
 * the skills chip and the context meter. Each was readable on its own and the
 * row was not: `Model`, `Permissions`, `Effort` and `Sandbox` are four words
 * about one question, which is *what am I talking to and how is it set*. They
 * wrapped onto a second line rather than shrinking, which was the right way to
 * degrade and still a toolbar that had outgrown its column.
 *
 * So they nest instead. One trigger says the answer — the agent as a mark, the
 * model, the effort — and the menu holds every setting behind it, one row each.
 * The previous attempt at this was to squeeze: `STYLE.md`'s density table and
 * the note in `Composer` both record what that produced (`G…`, `Ask …`, an
 * Effort button with no word in it). Nesting is the opposite move and the one
 * that keeps every label whole.
 *
 * ## The agent is named here, and cannot be changed here
 *
 * A session's agent is fixed when it starts: its process, its tmux, its home,
 * its pinned account. Nothing changes it, and the thing that looks like
 * changing it — `continue_with_account` — does not: it stops this agent,
 * summarises the transcript and opens a *second session* beside this one. That
 * is a workspace action with its own confirmation, its own permission
 * acknowledgement and its own preconditions (the server will only take it from
 * `HandedBack` or `Failed`), and it belongs where those can be explained.
 *
 * So the agent sits at the top of the menu as a heading rather than a row. It
 * is what the settings underneath belong to — they are literally its own, read
 * from `session_controls` — and a heading says that without offering a
 * checkmark next to something that is not a choice. A row drawn like the three
 * below it, that spawned a new conversation when clicked, was the first version
 * of this file and the reason for this paragraph.
 */
import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { AgentMark } from "~/components/AgentMark";
import type { Agent, Choice, Control, ControlKind } from "~/api/generated/model";

/**
 * What a caution looks like — and only one of the two gets a colour.
 *
 * Moved here with the pickers it paints, unchanged. `grants` is the fence
 * coming down, which is brick: the signal this palette already spends on
 * destruction.
 *
 * `neverAsks` deliberately gets **nothing**. It was red, alongside
 * "Everything", and it does not widen anything — Claude Code's `dontAsk`
 * refuses what it may not do and Codex's `never` fails. Ember is the obvious
 * second tone and is the one colour that must not be borrowed: `STYLE.md` opens
 * with "ember is the only loud thing on screen… it stops answering [is
 * something waiting on you] the moment it answers anything else", and the same
 * file rules out inventing a fourth hue. So the distinction is carried by the
 * note under the label, which already says what happens, and the alarm stays
 * spent on the one option that earns it.
 */
const CAUTION = { grants: "text-brick", neverAsks: undefined } as const;
const toneOf = (c?: Choice["caution"]) => (c ? CAUTION[c] : undefined);

export function AgentPicker({
  agent,
  agentLabel,
  controls,
  valueOf,
  onPick,
  disabled = false,
}: {
  /** Which agent is running this session. Fixed for its lifetime. */
  agent: Agent;
  /** Its name as this install reports it — `Claude Code`, not `ClaudeCode`. */
  agentLabel?: string;
  /** What this session reports it can be asked to change. */
  controls: Control[];
  /** What is in force for one of them, optimism and fallbacks already applied. */
  valueOf: (control: Control) => string | undefined;
  onPick: (kind: ControlKind, value: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<ControlKind | null>(null);

  // Escape backs out one level, then closes. Two presses to leave from inside
  // a pane, which is what every menu on this platform does.
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (pane) setPane(null);
      else setOpen(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, pane]);

  const shut = () => {
    setOpen(false);
    setPane(null);
  };

  /** The choice in force for one kind, when the agent has reported one. */
  const inForce = (kind: ControlKind): Choice | undefined => {
    const control = controls.find((c) => c.kind === kind);
    if (!control) return undefined;
    const value = valueOf(control);
    return control.choices.find((c) => c.value === value);
  };

  const name = agentLabel ?? agent;
  const model = inForce("model");
  const effort = inForce("effort");

  /* The agent's name until the model is known, rather than the word "Model"
     over a session that is plainly running something. Codex reports its models
     a moment after the session starts, and Claude Code restates its own only at
     the top of the next turn, so this is an ordinary state and not a brief
     one. */
  const headline = model?.label ?? name;

  /* Only what the agent may *do*, and only while it is in force. Four separate
     buttons each carried their own caution; one trigger has to carry all of
     them, or a session running with the fence down reads exactly like one
     inside it — and that is the state somebody comes back to, hours later. */
  const granting = controls.some((c) => inForce(c.kind)?.caution === "grants");

  const title = `${name}${model ? ` · ${model.label}` : ""}${effort ? ` · ${effort.label}` : ""}`;

  const face = (
    <>
      <AgentMark agent={agent} size={12} className="shrink-0" />
      <span className="truncate">{headline}</span>
      {/* The effort rides along dimmed rather than as a second control: it
          qualifies the model, the way "Opus · Extra high" is one answer and
          not two. */}
      {effort && <span className="truncate text-dim">· {effort.label}</span>}
    </>
  );

  /* Nothing to change, so nothing to click. An ACP session offers no controls
     at all, and a button that opens a menu with one heading in it is the
     "picker with nothing in it" this codebase already decided against. It
     still says what is running, which is more than the old row did. */
  if (controls.length === 0) {
    return (
      <span className="control max-w-[18rem] shrink-0 overflow-hidden text-mute" title={title}>
        {face}
      </span>
    );
  }

  return (
    <div className="relative">
      <button
        disabled={disabled}
        onClick={() => (open ? shut() : setOpen(true))}
        title={title}
        className={`control max-w-[18rem] shrink-0 overflow-hidden hover:bg-raise ${
          granting ? "text-brick hover:text-brick" : "text-mute hover:text-bone"
        }`}
      >
        {face}
        <ChevronDown className="h-3 w-3 shrink-0" strokeWidth={2} />
      </button>

      {open && (
        <>
          <button className="fixed inset-0 z-20 cursor-default" onClick={shut} />
          {/* Capped and scrolling, because the lists are the agent's and not
              ours: Codex reports a dozen models with a sentence each, which ran
              off the top of the window with the first few unreachable. `vh` as
              well as a fixed height — a short window is exactly where an
              uncapped list does the most damage. */}
          <div className="scroll-slim absolute bottom-full left-0 z-30 mb-1.5 max-h-[min(26rem,60vh)] w-[17rem] overflow-y-auto overflow-x-hidden rounded-lg border border-line bg-overlay p-1 shadow-(--shadow-float)">
            {pane === null ? (
              <>
                {/* Whose settings these are. A heading and not a row: the agent
                    is fixed for this session's life, and the one thing that
                    looks like changing it opens a second conversation. */}
                <div className="flex items-center gap-2 px-2.5 pt-1.5 pb-2">
                  <AgentMark agent={agent} size={11} className="shrink-0 text-mute" />
                  <span className="truncate text-meta text-mute">{name}</span>
                </div>
                {controls.map((c) => {
                  const here = inForce(c.kind);
                  return (
                    <Row
                      key={c.kind}
                      label={c.fallback}
                      value={here?.label}
                      tone={toneOf(here?.caution)}
                      onOpen={() => setPane(c.kind)}
                    />
                  );
                })}
              </>
            ) : (
              controls
                .filter((c) => c.kind === pane)
                .map((control) => (
                  <div key={control.kind}>
                    <Back label={control.fallback} onBack={() => setPane(null)} />
                    {control.choices.map((c) => (
                      <Option
                        key={c.value}
                        label={c.label}
                        note={c.note ?? undefined}
                        tone={toneOf(c.caution)}
                        chosen={c.value === valueOf(control)}
                        disabled={disabled}
                        onPick={() => {
                          onPick(control.kind, c.value);
                          shut();
                        }}
                      />
                    ))}
                  </div>
                ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** One setting on the first pane: what it is, what it is set to, and a way in. */
function Row({
  label,
  value,
  tone,
  onOpen,
}: {
  label: string;
  value?: string;
  tone?: string;
  onOpen: () => void;
}) {
  return (
    <button onClick={onOpen} className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-raise">
      <span className="min-w-0 flex-1 truncate text-ui text-bone">{label}</span>
      {/* Dimmer than the label it answers: the row is read left to right and
          the setting's name is what is being looked for. */}
      <span className={`min-w-0 shrink truncate text-ui ${tone ?? "text-mute"}`}>{value ?? ""}</span>
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-mute" strokeWidth={2} />
    </button>
  );
}

/** One choice on a second pane. The shape the single pickers always had. */
function Option({
  label,
  note,
  tone,
  chosen,
  disabled = false,
  onPick,
}: {
  label: string;
  note?: string;
  tone?: string;
  chosen: boolean;
  disabled?: boolean;
  onPick: () => void;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onPick}
      className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-raise"
    >
      <Check className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${chosen ? "text-bone" : "text-transparent"}`} strokeWidth={2} />
      <span className="min-w-0">
        <span className={`block truncate text-ui ${tone ?? "text-bone"}`}>{label}</span>
        {note && <span className="block text-meta text-mute">{note}</span>}
      </span>
    </button>
  );
}

/** The way back, and the name of where you are. */
function Back({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <button onClick={onBack} className="flex w-full items-center gap-1.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-raise">
      <ChevronLeft className="h-3.5 w-3.5 shrink-0 text-mute" strokeWidth={2} />
      <span className="text-ui text-dim">{label}</span>
    </button>
  );
}
