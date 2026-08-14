"use client";

import type { Event, Session, Step } from "@/src/api/generated/model";

/**
 * What a session is doing, as a list that exists before it starts doing it.
 *
 * The plan is decided when the session is created, so this renders in full the
 * moment the page loads — every step pending, the first one about to run.
 * Deriving the list from events instead would mean a session that spends eight
 * minutes fetching a repository shows an empty page for eight minutes, which is
 * indistinguishable from being broken.
 */

const LABELS: Record<Step, string> = {
  Fetch: "Fetching the repository",
  Worktree: "Creating the worktree",
  Workspace: "Making the workspace",
  Setup: "Running setup",
  Launch: "Starting the agent",
};

/** Which event finishes which step. The same mapping the control plane uses. */
const FINISHED_BY: Record<string, Step> = {
  RepoFetched: "Fetch",
  WorktreeAdded: "Worktree",
  WorkspaceStarted: "Workspace",
  SetupFinished: "Setup",
  AgentLaunched: "Launch",
};

type Kind = Record<string, unknown> & { type?: string };
type State = "done" | "running" | "failed" | "pending";

type Line = {
  step: Step;
  state: State;
  /** What the worker last said about it — a duration, a percentage, an error. */
  detail: string;
};

/** Events the checklist speaks for, so the activity list doesn't repeat them. */
export const STEP_EVENTS = new Set([
  "StepStarted",
  "StepProgress",
  ...Object.keys(FINISHED_BY),
]);

export function stepLines(session: Session, events: Event[]): Line[] {
  const state = new Map<Step, State>();
  const detail = new Map<Step, string>();

  let latest: Step | null = null;

  for (const e of events) {
    const kind = e.kind as Kind;
    const step = (kind.step ?? FINISHED_BY[kind.type ?? ""]) as Step | undefined;

    switch (kind.type) {
      case "StepStarted":
        if (step) {
          state.set(step, "running");
          latest = step;
        }
        break;
      case "StepProgress":
        if (step) detail.set(step, String(kind.detail ?? ""));
        break;
      case "Failed":
        // A failure belongs to whatever was running when it happened —
        // that's the line someone is looking for.
        if (latest) {
          state.set(latest, "failed");
          detail.set(latest, String(kind.message ?? ""));
        }
        break;
      default:
        if (step) {
          state.set(step, "done");
          detail.set(step, String(kind.detail ?? kind.branch ?? ""));
        }
    }
  }

  // A session created before steps were recorded has none; the activity list
  // below is what it always had.
  return (session.steps ?? []).map((step) => ({
    step,
    state: state.get(step) ?? "pending",
    detail: detail.get(step) ?? "",
  }));
}

export function Steps({ session, events }: { session: Session; events: Event[] }) {
  const lines = stepLines(session, events);
  if (lines.length === 0) return null;

  return (
    <ol className="flex flex-col gap-2">
      {lines.map((line) => (
        <li key={line.step} className="flex gap-2.5">
          <Mark state={line.state} />
          <span className="min-w-0 flex-1">
            <span
              className={`block text-[12.5px] ${
                line.state === "pending"
                  ? "text-mute"
                  : line.state === "failed"
                    ? "text-brick"
                    : "text-dim"
              }`}
            >
              {LABELS[line.step]}
            </span>
            {line.detail && (
              <span
                className={`mt-0.5 block font-mono text-[11px] leading-[1.5] ${
                  line.state === "failed" ? "text-brick/80" : "text-mute"
                } ${line.state === "failed" ? "whitespace-pre-wrap" : "truncate"}`}
              >
                {line.detail}
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

/* A tick, a spinner, a cross, or nothing yet — readable at a glance without
   reading any of the words. */
function Mark({ state }: { state: State }) {
  if (state === "done") {
    return (
      <svg viewBox="0 0 14 14" className="mt-[3px] h-3 w-3 shrink-0 text-sage" fill="none">
        <path
          d="M2.5 7.5l3 3 6-7"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (state === "failed") {
    return (
      <svg viewBox="0 0 14 14" className="mt-[3px] h-3 w-3 shrink-0 text-brick" fill="none">
        <path
          d="M3.5 3.5l7 7M10.5 3.5l-7 7"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (state === "running") {
    return (
      <svg viewBox="0 0 14 14" className="mt-[3px] h-3 w-3 shrink-0 animate-spin text-ember" fill="none">
        <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.6" opacity="0.25" />
        <path d="M7 2a5 5 0 015 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <span className="mt-[7px] h-[5px] w-[5px] shrink-0 rounded-full border border-line" />
  );
}
