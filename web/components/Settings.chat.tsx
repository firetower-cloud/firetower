"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The things about a running session somebody can change.
 *
 * Each is a slash command the agent already understands, sent down the same
 * path as any other message — there is no separate control channel and none is
 * needed. Verified against a live session rather than assumed: each one takes
 * effect immediately and answers with a sentence.
 *
 * The row these live in used to be a caption. Printing `claude-sonnet-5` beside
 * a repository name looks exactly like the row in a tool where those are
 * pickers, which is worse than not being there: it promises something and does
 * nothing.
 */

export type Choice = {
  /** What the picker shows when this is in force. */
  label: string;
  /** What gets sent. */
  value: string;
  /** Why somebody would pick it, when that is not obvious. */
  note?: string;
  /** Drawn apart, because it changes what the agent may do unsupervised. */
  grave?: boolean;
};

/**
 * The models a session can be moved to.
 *
 * The long-context variants are offered where they exist, because a session
 * here is unattended and often long — which is exactly the shape of work that
 * runs out of room.
 *
 * `bypassPermissions` has no equivalent here on purpose; see `MODES`.
 */
export const MODELS: Choice[] = [
  { label: "Opus", value: "opus[1m]", note: "The flagship, long context" },
  { label: "Fable", value: "fable[1m]", note: "More capable, more expensive" },
  { label: "Sonnet", value: "sonnet[1m]", note: "Quicker, cheaper" },
  { label: "Haiku", value: "haiku", note: "Fastest, for small things" },
  { label: "Opus plan", value: "opusplan", note: "Plans with Opus, works with Sonnet" },
];

/**
 * What the agent may do without asking.
 *
 * The one control here that changes what happens while nobody is watching, so
 * the ordinary setting reads as unremarkable and the rest say what they mean.
 *
 * `bypassPermissions` is deliberately absent. It is a flag for a sandbox
 * somebody built on purpose rather than an item in a menu — and Claude Code
 * refuses it as root anyway, which is what the worker container runs as.
 */
export const MODES: Choice[] = [
  { label: "Auto", value: "auto", note: "Approves the ordinary, asks about the rest" },
  { label: "Ask everything", value: "default", note: "Nothing runs unasked" },
  { label: "Plan", value: "plan", note: "Explores and proposes, changes nothing" },
  {
    label: "Accept edits",
    value: "acceptEdits",
    note: "Writes files without asking. Commands still ask",
    grave: true,
  },
  {
    label: "Never ask",
    value: "dontAsk",
    note: "Refuses anything not already allowed, rather than asking",
    grave: true,
  },
];

/** How hard it thinks. */
export const EFFORTS: Choice[] = [
  { label: "Low", value: "low", note: "Quick, for small things" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high", note: "The usual" },
  { label: "Max", value: "max", note: "Slow, and as good as it gets" },
];

/** The slash command that puts each one into force. */
export function command(kind: "model" | "mode" | "effort", value: string): string {
  switch (kind) {
    case "model":
      return `/model ${value}`;
    // `/permissions` is not available headless; `/config` is, and takes it.
    case "mode":
      return `/config permissionMode=${value}`;
    case "effort":
      return `/effort ${value}`;
  }
}

/**
 * A small menu that reads as one word until it is opened.
 *
 * Shows what is in force, not what was asked for. When nothing is known it says
 * so by staying quiet rather than claiming a default that may be wrong.
 */
export function Picker({
  choices,
  current,
  fallback,
  onPick,
  disabled,
}: {
  choices: Choice[];
  /** The value in force, if it is known. */
  current?: string;
  /** What to show when it is not. */
  fallback: string;
  onPick: (value: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  // Matched loosely: the agent answers with a full identifier where the command
  // takes a short name, so `claude-opus-5[1m]` has to find `opus[1m]`.
  const showing = choices.find((c) => matches(c.value, current));

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen(!open)}
        disabled={disabled}
        className="flex h-8 items-center gap-1.5 rounded-full px-3 text-ui text-dim transition-colors hover:bg-raise hover:text-bone disabled:opacity-50"
      >
        {showing?.label ?? fallback}
        <svg viewBox="0 0 10 10" aria-hidden className="h-2.5 w-2.5 opacity-50" fill="none" stroke="currentColor">
          <path d="M2.5 4l2.5 2.5L7.5 4" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <ul className="absolute bottom-full left-0 z-20 mb-2 max-h-[340px] w-[264px] overflow-y-auto rounded-[14px] border border-line bg-panel py-1.5 shadow-[0_12px_36px_-14px_rgba(0,0,0,0.85)]">
          {choices.map((choice, i) => {
            const on = matches(choice.value, current);
            const first = choice.grave && !choices[i - 1]?.grave;
            return (
              <li key={choice.value} className={first ? "mt-1 border-t border-line pt-1" : ""}>
                <button
                  onClick={() => {
                    setOpen(false);
                    if (!on) onPick(choice.value);
                  }}
                  className="w-full px-3.5 py-2 text-left transition-colors hover:bg-raise"
                >
                  <span
                    className={`block text-ui ${
                      on ? "text-ember" : choice.grave ? "text-dim" : "text-text"
                    }`}
                  >
                    {choice.label}
                  </span>
                  {choice.note && (
                    <span className="mt-0.5 block text-meta text-mute">{choice.note}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Whether a choice is the thing currently in force.
 *
 * The agent reports `claude-opus-5[1m]` where the command takes `opus[1m]`, and
 * reports `acceptEdits` exactly. So: equal, or the reported name contains the
 * short one — checked longest-first by the caller's ordering so `opus` does not
 * claim a session running `opusplan`.
 */
function matches(value: string, current?: string): boolean {
  if (!current) return false;
  if (value === current) return true;

  const shortened = value.replace("[1m]", "");
  const long = current.includes("[1m]");
  return current.includes(shortened) && (!value.includes("[1m]") || long);
}
