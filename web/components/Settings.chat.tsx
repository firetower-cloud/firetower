"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The picker itself. What goes in it comes from the server.
 *
 * The lists used to be here, which was right for as long as there was one
 * agent to be right about. A second one made every one of them wrong — and the
 * mechanism with it, since picking a model built `/model opus[1m]` and sent it
 * as a message. Claude Code reads that out of its own input; Codex reads it as
 * a sentence about Opus and spends a turn on it.
 *
 * So which knobs a session has, what is in them, and what picking one means
 * are all answered by whatever is driving the agent. This draws the answer.
 *
 * The row these live in used to be a caption. Printing `claude-sonnet-5` beside
 * a repository name looks exactly like the row in a tool where those are
 * pickers, which is worse than not being there: it promises something and does
 * nothing.
 */

import type { Choice, Control, ControlKind } from "@/src/api/generated/model";

export type { Choice, Control, ControlKind };

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
