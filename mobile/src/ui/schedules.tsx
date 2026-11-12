/**
 * What the phone says about a schedule and its runs.
 *
 * The same folds as the desk, written once here so the two clients cannot
 * come to disagree about what a run's mark means or what stopped a schedule.
 */
import { Check, CircleDashed, CircleSlash2, TriangleAlert } from "lucide-react-native";
import { View } from "react-native";
import type { Schedule, ScheduleRun } from "~/api/generated/model";
import { useTheme } from "~/design/theme";

/** One run's mark. Four are the shared ones; *no agent started* is this
 *  feature's own, because nothing else in the product had to say it. */
export function RunMark({ run }: { run: ScheduleRun }) {
  const { color } = useTheme();
  if (run.state === "claimed" || run.state === "running") {
    return <View className="h-2 w-2 rounded-full" style={{ backgroundColor: color.slate }} />;
  }
  if (run.state === "failed") return <TriangleAlert size={14} color={color.brick} strokeWidth={2} />;
  if (run.state === "finished" && run.outcome === "needs_you") {
    return <CircleDashed size={14} color={color["ember-ink"]} strokeWidth={2} />;
  }
  if (run.state === "finished" && run.outcome !== "overran") {
    return <Check size={14} color={color.sage} strokeWidth={2} />;
  }
  return <CircleSlash2 size={14} color={color.mute} strokeWidth={2} />;
}

/**
 * The line a run shows.
 *
 * **The fallback is derived from the state, never a word that claims an
 * outcome.** It used to end in `"Finished."` for any run with no sentence
 * yet, which is every run between being claimed and being settled — so
 * pressing *Run now* drew a finished run before anything had started, and a
 * run the capacity gate then refused kept that line.
 */
export function runLine(run: ScheduleRun): string {
  const said = run.detail?.trim() || run.summary?.trim();
  if (said) return said;
  switch (run.state) {
    case "claimed":
      return "Starting…";
    case "running":
      return "Running.";
    case "refused":
      return "Refused. Nothing was started.";
    case "skipped":
      return "Skipped. The previous run was still going.";
    case "missed":
      return "Missed. Firetower was not running.";
    case "lost":
      return "Did not start. The control plane restarted while this run was starting.";
    case "failed":
      return "Failed.";
    default:
      return "Finished.";
  }
}

/** Whether anything about this schedule is still moving — what the screen
 *  polls on while a run is being launched. */
export function stillMoving(runs: ScheduleRun[]): boolean {
  return runs.some((r) => r.state === "claimed" || r.state === "running");
}

/**
 * The sub-line under a schedule's name.
 *
 * One sentence for every pose rather than a dialect per width: 466 is not a
 * wider 390, and what the extra room buys is a whole word rather than a wider
 * abbreviation.
 */
export function says(schedule: Schedule): string {
  if (!schedule.active) {
    if (schedule.made.byAgent && !schedule.approvedAt) return "Waiting for you to turn it on";
    return schedule.pausedReason ? "Firetower stopped it" : "Paused";
  }
  const at = schedule.triggers[0]?.nextFireAt;
  if (!at) return "On";
  const when = new Date(at);
  return `Next run ${when.toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })}`;
}

/**
 * Which rule stopped it, in words, counted rather than read.
 *
 * The same derivation the desk makes: `pausedReason` holds the rule and
 * nothing else, and a mixed streak gets its own tag rather than a choice
 * between the other two.
 */
export function tagOf(schedule: Schedule): string | null {
  if (schedule.active || !schedule.pausedReason) return null;
  switch (schedule.pausedReason) {
    case "three_failures":
      return "Kept failing";
    case "five_runs": {
      const failing = schedule.streak.failures > 0 || schedule.streak.unreachable > 0;
      const asking = schedule.streak.questions > 0;
      if (failing && asking) return "Kept failing and asking";
      return asking ? "Kept needing you" : "Kept failing";
    }
    case "overran":
      return "Kept overrunning";
    default:
      return "Firetower stopped it";
  }
}
