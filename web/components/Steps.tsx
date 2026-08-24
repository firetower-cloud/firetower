"use client";

import type { Event, Session, Step } from "@/src/api/generated/model";

/**
 * What a session did to come up, said in the conversation as it happens.
 *
 * Bringing a session up is the first thing that happens to it, so it belongs at
 * the top of the transcript rather than in a panel beside one — and once the
 * agent is talking it has scrolled away, which is the right amount of attention
 * for it.
 *
 * Only steps that have actually started are drawn. The whole plan up front is
 * five grey lines saying nothing has happened yet; the running step, carrying
 * whatever the worker last said about it, is the part that answers the only
 * question anybody has here, which is whether it is stuck.
 */

const LABELS: Record<Step, string> = {
  Fetch: "Fetching the repository",
  Worktree: "Creating the worktree",
  Workspace: "Making the workspace",
  Setup: "Running setup",
  Launch: "Starting the agent",
};

/**
 * What a finished step is worth saying.
 *
 * Ordinarily the branch, or whatever detail the worker sent. A worktree whose
 * branch had to be renamed says so instead — two sessions started from the same
 * prompt want the same name and only one can have it, and reading that off the
 * pull request afterwards is reading it too late.
 */
function finished(kind: Kind): string {
  const branch = kind.branch ? String(kind.branch) : "";
  const asked = kind.askedFor ? String(kind.askedFor) : "";
  if (branch && asked) return `${branch} — ${asked} was already taken`;
  return String(kind.detail ?? branch);
}

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

export type Line = {
  step: Step;
  state: State;
  /** What the worker last said about it — a duration, a percentage, an error. */
  detail: string;
};

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
          detail.set(step, finished(kind));
        }
    }
  }

  // A session created before steps were recorded has none, and draws nothing.
  return (session.steps ?? []).map((step) => ({
    step,
    state: state.get(step) ?? "pending",
    detail: detail.get(step) ?? "",
  }));
}

/**
 * The bring-up, in the transcript's margin.
 *
 * Same marks as everything else there — ○ running, ✕ failed, and nothing for a
 * step that simply worked — because these are events in the same run and
 * reading them should take no new vocabulary.
 */
export function Bringup({ lines }: { lines: Line[] }) {
  const started = lines.filter((l) => l.state !== "pending");
  if (started.length === 0) return null;

  return (
    <ol className="spine mb-2.5 flex flex-col gap-2.5">
      {started.map((line) => (
        <li key={line.step} className="node">
          {line.state !== "done" && (
            <span className="mark" data-state={line.state}>
              {line.state === "running" ? "\u25CB" : "\u2715"}
            </span>
          )}
          <span
            className={`text-[13.5px] ${line.state === "failed" ? "text-brick" : "text-dim"}`}
          >
            {LABELS[line.step]}
          </span>
          {line.detail && (
            <div
              className={`mt-0.5 font-mono text-[12px] leading-[1.5] ${
                line.state === "failed" ? "whitespace-pre-wrap text-brick/80" : "truncate text-mute"
              }`}
            >
              {line.detail}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
