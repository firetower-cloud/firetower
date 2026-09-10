"use client";

/**
 * Every knob this session has, in the room there is for them.
 *
 * On a desk that is one `Picker` per control, side by side on the composer's
 * floor — three words, plenty of room, and each one readable without being
 * opened.
 *
 * On a phone it is not. `Opus 5`, `acceptEdits` and `high` beside a `+` and a
 * send button is four controls and a picture in 375px, and the first casualty
 * is the send button. So below `md` they collapse to one chip showing the
 * thing anybody actually wants to see — the model — which opens a sheet with
 * all of them.
 *
 * Which one is the summary is deliberate rather than "the first". A session's
 * model is the thing people check before sending an expensive message; its
 * permission mode is a thing they set once. If an agent reports no model, the
 * chip falls back to whatever it does report, so it never collapses to nothing
 * and hides controls that exist.
 */

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Icon } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { Picker, type Control } from "@/components/Settings.chat";

export function Pickers({
  controls,
  disabled,
  onSet,
}: {
  controls: Control[];
  disabled: boolean;
  onSet: (kind: Control["kind"], value: string) => void;
}) {
  const [sheet, setSheet] = useState(false);

  if (controls.length === 0) return null;

  const summary = controls.find((c) => c.kind === "model") ?? controls[0];
  const showing =
    summary.choices.find((c) => c.value === summary.current)?.label ??
    summary.current ??
    summary.fallback;

  return (
    <>
      {/* The desk's row. Hidden rather than not rendered, so there is one list
          of controls and not two that can disagree about what a session has. */}
      <span className="hidden items-center gap-0.5 md:flex">
        {controls.map((control) => (
          <Picker
            key={control.kind}
            choices={control.choices}
            current={control.current ?? undefined}
            fallback={control.fallback}
            disabled={disabled}
            onPick={(v) => onSet(control.kind, v)}
          />
        ))}
      </span>

      <button
        onClick={() => setSheet(true)}
        disabled={disabled}
        aria-label="Settings for this session"
        className="flex min-h-[44px] max-w-[14ch] items-center gap-1 rounded-full px-2.5 text-ui text-dim transition-colors hover:bg-raise hover:text-bone disabled:opacity-50 md:hidden"
      >
        <span className="truncate">{showing}</span>
        <Icon of={ChevronDown} size={12} className="shrink-0 opacity-60" />
      </button>

      {sheet && (
        <Modal title="This session" onClose={() => setSheet(false)}>
          <div className="flex flex-col gap-4">
            {controls.map((control) => (
              <Knob
                key={control.kind}
                control={control}
                disabled={disabled}
                onPick={(v) => {
                  onSet(control.kind, v);
                  setSheet(false);
                }}
              />
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}

/**
 * One control, opened out.
 *
 * A list rather than a dropdown inside a sheet. A menu that opens another menu
 * on a phone is two layers to dismiss and a target that moves under the thumb
 * between them; there is room here to just show the choices.
 */
function Knob({
  control,
  disabled,
  onPick,
}: {
  control: Control;
  disabled: boolean;
  onPick: (value: string) => void;
}) {
  return (
    <div>
      <p className="eyebrow mb-1.5">{control.fallback}</p>
      <div className="flex flex-col">
        {control.choices.map((choice, i) => {
          const on = matches(choice.value, control.current ?? undefined);
          const first = choice.grave && !control.choices[i - 1]?.grave;
          return (
            <button
              key={choice.value}
              disabled={disabled}
              onClick={() => !on && onPick(choice.value)}
              className={`flex min-h-[52px] items-center gap-3 rounded-md px-2 text-left transition-colors enabled:hover:bg-raise disabled:opacity-50 ${
                first ? "mt-1 border-t border-line pt-1" : ""
              }`}
            >
              <span className="min-w-0 flex-1">
                <span
                  className={`block text-ui ${
                    on ? "text-bone" : choice.grave ? "text-dim" : "text-text"
                  }`}
                >
                  {choice.label}
                </span>
                {choice.note && (
                  <span className="block text-meta text-mute">{choice.note}</span>
                )}
              </span>
              {/* The one in force, said with a mark rather than only with a
                  brighter label — on a phone in daylight, one step of grey is
                  not a signal. */}
              {on && <span className="shrink-0 text-ui text-bone">✓</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Whether a choice is the thing currently in force.
 *
 * The same loose match `Picker` makes, and for the same reason: the agent
 * reports `claude-opus-5[1m]` where the command takes `opus[1m]`.
 */
function matches(value: string, current?: string): boolean {
  if (!current) return false;
  return current === value || current.includes(value);
}
