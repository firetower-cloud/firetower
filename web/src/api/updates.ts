import type {
  FilePlan,
  HostTarget,
  RunState,
  StepState,
  UpdateRun,
  UpdateStatus,
} from "./generated/model";

/**
 * What the Updates screen works out for itself.
 *
 * Pure, so the questions a run raises — what would end, what is behind, how
 * long it took — are answered the same way on the screen and under a test.
 */

/** Which of the targets a person may tick. */
export type Chosen = { controlPlane: boolean; hostIds: string[] };

/** Everything that can be moved, ticked. What the screen starts with. */
export function everythingUpgradable(status: UpdateStatus): Chosen {
  return {
    controlPlane: status.controlPlane.upgradable,
    hostIds: status.hosts.filter((h) => h.upgradable).map((h) => h.hostId),
  };
}

/** Nothing ticked means nothing to do. */
export function nothingChosen(chosen: Chosen): boolean {
  return !chosen.controlPlane && chosen.hostIds.length === 0;
}

/**
 * The sessions that end if the chosen targets are recreated now, by title
 * and by where they are — what the confirmation has to say out loud.
 */
export function wouldEnd(
  status: UpdateStatus,
  chosen: Chosen,
): { where: string; sessions: string[] }[] {
  const ended: { where: string; sessions: string[] }[] = [];
  if (chosen.controlPlane && status.controlPlane.sessions.length > 0) {
    ended.push({ where: "this machine", sessions: status.controlPlane.sessions });
  }
  for (const host of status.hosts) {
    if (chosen.hostIds.includes(host.hostId) && host.sessions.length > 0) {
      ended.push({ where: host.name, sessions: host.sessions });
    }
  }
  return ended;
}

export function countEnded(ended: { sessions: string[] }[]): number {
  return ended.reduce((n, e) => n + e.sessions.length, 0);
}

/** "2 sessions" / "a session" — the number, said. */
export function sessionsWord(n: number): string {
  return n === 1 ? "a session" : `${n} sessions`;
}

/** What a host row says on its right-hand side. */
export function hostNote(host: HostTarget): string {
  if (host.reason) return host.reason;
  if (host.sessions.length > 0) return `ends ${sessionsWord(host.sessions.length)}`;
  return "idle";
}

/** Whether a file needs a decision from a person before a run may write it. */
export function needsChoice(file: FilePlan): boolean {
  return file.verdict === "Edited";
}

/** Whether a file is written at all, given the choice made about it. */
export function willWrite(file: FilePlan, replace: boolean): boolean {
  switch (file.verdict) {
    case "Update":
    case "New":
      return true;
    case "Edited":
      return replace;
    default:
      return false;
  }
}

export const ACTIVE: RunState[] = ["planned", "waitingIdle", "waitingDecision", "running"];

export const isActive = (run: { state: RunState }) => ACTIVE.includes(run.state);

/** A run's state, in a word for a badge. */
export const RUN_LABEL: Record<RunState, string> = {
  planned: "starting",
  waitingIdle: "waiting for idle",
  waitingDecision: "waiting for you",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
};

export function runTone(state: RunState): "sage" | "brick" | "slate" | "neutral" {
  switch (state) {
    case "succeeded":
      return "sage";
    case "failed":
      return "brick";
    case "waitingDecision":
      return "brick";
    case "running":
    case "waitingIdle":
    case "planned":
      return "slate";
    default:
      return "neutral";
  }
}

/** Whether this run is stopped waiting for somebody to answer. */
export const needsAnAnswer = (run: { state: RunState }) => run.state === "waitingDecision";

/** The glyph in front of a step. */
export function stepGlyph(state: StepState): string {
  switch (state) {
    case "done":
      return "✓";
    case "failed":
      return "✗";
    case "running":
      return "●";
    case "warned":
      return "!";
    case "skipped":
      return "–";
    default:
      return "○";
  }
}

/** How long something took, or has been going: "4m12s", "18s", "1h03m". */
export function duration(from?: string | null, to?: string | null): string {
  if (!from) return "";
  const start = new Date(from).getTime();
  const end = to ? new Date(to).getTime() : Date.now();
  const s = Math.max(0, Math.round((end - start) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

/** One line for the history: what moved, how it went, how long. */
export function runSummary(run: UpdateRun): string {
  const parts = [`${run.fromVersion} → ${run.toVersion}`, RUN_LABEL[run.state]];
  const took = duration(run.startedAt, run.finishedAt);
  if (took && !isActive(run)) parts.push(took);
  return parts.join(" · ");
}

/** Whether the rail shows its dot. */
export function showsDot(status: UpdateStatus | undefined): boolean {
  return !!status && (status.updateAvailable || !!status.activeRun);
}

/** A diff, line by line, with what each line is. */
export function diffLines(diff: string): { kind: "add" | "del" | "hunk" | "meta" | "same"; text: string }[] {
  return diff
    .split("\n")
    .filter((l, i, all) => !(i === all.length - 1 && l === ""))
    .map((text) => {
      if (text.startsWith("+++") || text.startsWith("---")) return { kind: "meta" as const, text };
      if (text.startsWith("@@")) return { kind: "hunk" as const, text };
      if (text.startsWith("+")) return { kind: "add" as const, text };
      if (text.startsWith("-")) return { kind: "del" as const, text };
      return { kind: "same" as const, text };
    });
}
