/**
 * What a picker shows, and what tapping one should do.
 *
 * Split out of `Composer` for the reason the parse in `markdown.ts` is:
 * `react-native` is stubbed under the test runner, so a pure function is the
 * only part that can be checked without a renderer — and the ACP rules are
 * where the interesting questions are.
 *
 * The two agents differ in when a setting is true. Claude and Codex take one
 * on the next turn, so the label can move the moment it is tapped and be
 * right. An ACP session applies it by RPC and may refuse, so the label must
 * not claim anything the agent has not confirmed.
 */
import type { Control, ControlKind } from "~/api/generated/model";

/**
 * The value a picker displays.
 *
 * `chosen` is the optimistic note of what was just tapped. An ACP session
 * ignores it: `current` is what the agent has actually confirmed, and until
 * that arrives the picker keeps showing the old value rather than a new one
 * that may yet be refused. The conversation's own model and mode are the last
 * resort, for a control the agent has not reported a value for yet.
 */
export function shownValue(opts: {
  acp: boolean;
  control: Pick<Control, "kind" | "current">;
  chosen: Partial<Record<string, string>>;
  model?: string;
  mode?: string;
}): string | undefined {
  const { acp, control, chosen, model, mode } = opts;
  return (
    (acp ? undefined : chosen[control.kind]) ??
    control.current ??
    (control.kind === "model" ? model : control.kind === "mode" ? mode : undefined) ??
    undefined
  );
}

/**
 * The settings that are a lasting preference rather than a one-off. Carried
 * as the kind itself rather than a flag, so that only these three can reach
 * the callback that stores them.
 */
export type Remembered = "model" | "mode" | "effort";

/** What tapping a choice should do. */
export type PickPlan =
  | { act: "ignore" }
  | { act: "send"; optimistic: boolean; remember: Remembered | null };

/**
 * ACP sends and waits: nothing is written down locally and nothing is kept as
 * a preference, because the agent owns its own configuration and is the only
 * thing that can say the change took.
 *
 * A change already in flight refuses the next one for either kind of agent.
 * The worker rejects a second configuration while the first is outstanding,
 * and two pickers disagreeing about which one won is worse than one that will
 * not move.
 */
export function planPick(opts: {
  acp: boolean;
  pending: boolean;
  kind: ControlKind;
}): PickPlan {
  if (opts.pending) return { act: "ignore" };
  if (opts.acp) return { act: "send", optimistic: false, remember: null };
  const { kind } = opts;
  return {
    act: "send",
    optimistic: true,
    remember: kind === "model" || kind === "mode" || kind === "effort" ? kind : null,
  };
}
