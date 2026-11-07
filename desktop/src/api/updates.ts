import type {
  FilePlan,
  HostTarget,
  RunState,
  StepState,
  UpdateRun,
  UpdateStatus,
  UpgradePlan,
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
 * Whether the run may be started.
 *
 * The plan is a condition only when the control plane is a target. It answers
 * what an upgrade writes to the deployment's files, and a worker upgrade
 * writes none of them — so waiting for one either way is what left a worker
 * alone and behind on a deployment whose updater was never configured, under
 * a message about a container that had no part in it.
 */
export function canStart(chosen: Chosen, plan: UpgradePlan | undefined): boolean {
  if (nothingChosen(chosen)) return false;
  return !chosen.controlPlane || !!plan;
}

/**
 * The sessions that end if the chosen targets are reinstalled now, by title
 * and by where they are — what the confirmation has to say out loud.
 */
export function wouldEnd(
  status: UpdateStatus,
  chosen: Chosen,
): { where: string; sessions: string[] }[] {
  const ended: { where: string; sessions: string[] }[] = [];
  // Nothing for the control plane. A session could once run as a child of its
  // process, so recreating the container ended whatever was in it; nothing
  // runs there now, and `ControlPlaneTarget` has no `sessions` to read.
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

/**
 * The profile menu's Updates row, and the mark on the avatar above it.
 *
 * Two release trains answer to one row: this app's own build, and the
 * deployment it is pointed at. Either one being behind is something there is to
 * take, so either one lights the mark.
 *
 * **`dot` means one thing: there is an update to take.** Nothing else may set
 * it. It is the only signal on the avatar besides the ember one, it is read
 * without hover and without opening anything, and a mark that can mean several
 * things means nothing — so a run already going, a failed check or an unread
 * release note do not get to borrow it. `ProfileMenu.tsx` says the same thing
 * at the site that draws it.
 *
 * **`label` carries what the mark cannot: which version.** The mark says
 * something is in here; the row says what, and "Update available" with no
 * number is a sentence you have to open the screen to act on. The deployment's
 * release wins when both trains are behind — it is the thing the Updates screen
 * acts on, and the app's own build moves itself.
 *
 * A run in progress says so in words and takes no mark. It is worth knowing
 * about, there is nothing in it to decide, and you are the one who started it.
 */
export function updatesRow(
  status: UpdateStatus | undefined,
  /** The build that is out, if this app's own check found a newer one. */
  newBuild: string | null,
): { label: string; dot: boolean } {
  if (status?.updateAvailable || newBuild) {
    const ready = (status?.updateAvailable ? status.latest?.version : null) ?? newBuild;
    return { label: ready ? `Update available — ${ready}` : "Update available", dot: true };
  }
  return { label: status?.activeRun ? "Upgrading…" : "Updates", dot: false };
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
