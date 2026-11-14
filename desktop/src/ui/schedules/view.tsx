/**
 * The marks and the small formatting a schedule's rows need.
 *
 * **Five marks, not two.** `done`, `needed` and `failed` are the three the
 * security review insists are distinct; `skipped`, `refused` and `missed` are
 * the three where no agent ever started, told apart by their sentence rather
 * than by a mark of their own. Four of the five are `BeatMark`'s; the fifth —
 * *no agent started* — is this feature's, because nothing in the product had
 * needed to say that before.
 */
import { Check, CircleDashed, CircleSlash2, TriangleAlert } from "lucide-react";
import { Icon } from "~/components/ui";
import type { Outcome, ScheduleRunState, ScheduleRun, Trigger } from "~/api/generated/model";

/** What a run's row leads with. */
export function RunMark({ run }: { run: ScheduleRun }) {
  switch (what(run)) {
    case "working":
      return (
        <span className="typing" title="Running now">
          <i />
          <i />
          <i />
        </span>
      );
    case "done":
      return <Icon of={Check} size={14} className="text-[var(--color-sage)]" aria-label="finished" />;
    case "failed":
      return (
        <Icon of={TriangleAlert} size={14} className="text-[var(--color-brick)]" aria-label="failed" />
      );
    case "needed":
      return (
        <Icon
          of={CircleDashed}
          size={14}
          className="text-[var(--color-amber)]"
          aria-label="stopped because it needed you"
        />
      );
    /* **Missed shares this mark and not its sentence.** All three mean no
       agent started, which is what the mark says; why, and whether anything
       will be done about it, is the row's own line. */
    default:
      return (
        <Icon of={CircleSlash2} size={14} className="text-[var(--color-mute)]" aria-label="no agent started" />
      );
  }
}

/** Which of the five a run is. */
export function what(run: ScheduleRun): "working" | "done" | "needed" | "failed" | "over" {
  if (run.state === "claimed" || run.state === "running") return "working";
  if (run.state === "failed") return "failed";
  if (run.state === "finished") {
    if (run.outcome === "needs_you") return "needed";
    if (run.outcome === "overran") return "over";
    return "done";
  }
  return "over";
}

/**
 * Why a kept workspace is kept, in the row's own words.
 *
 * **The fourth reason is the one that had to be said out loud.** Deciding
 * whether a finished run left anything behind means a live round trip to the
 * machine; when the machine has gone, nothing can classify the run at all.
 * Keeping it is right. Telling somebody it was kept *because something was
 * uncommitted* would be a guess stated as a fact.
 */
export function keptWhy(run: ScheduleRun, opts: { norepo?: boolean; keepall?: boolean } = {}): string {
  if (!run.workspaceKept) {
    return run.state === "finished"
      ? "The workspace was deleted after this run. Only this record is kept."
      : "No workspace was started.";
  }
  if (opts.norepo)
    return "Kept: nothing is checked out, so there is no way to tell what this run left.";
  if (run.outcome === "unknown")
    return "Kept: the machine could not be reached when this run finished, so what it left could not be read.";
  if (run.state === "failed") return "Kept: the run failed.";
  if (run.outcome === "needs_you") return "Kept: the run is still waiting for your answer.";
  if (run.state === "running" || run.state === "claimed") return "Running now.";
  if (opts.keepall) return "Kept: this schedule deletes nothing automatically.";
  return "Kept: the run left work uncommitted or unpushed.";
}

/**
 * The line a run shows.
 *
 * The server's sentence first — it is written for a person and it is the one
 * the history is meant to carry — then the agent's own summary.
 *
 * **The fallback is derived from the state, never a word that claims an
 * outcome.** It used to end in `"Finished."` for any run with no sentence
 * yet, which is every run between being claimed and being settled: pressing
 * *Run now* drew a finished run before anything had started, and a run the
 * capacity gate then refused kept that line. Telling somebody their
 * unattended work ran when it did not is the worst thing this screen can do,
 * so there is no longer any path to a word the run has not earned.
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

/**
 * Whether a run has reached a state nothing follows.
 *
 * Read from the state rather than from `endedAt`, because a run is settled by
 * a sweep and the two are written in one statement — but the state is what
 * every other reader here asks about.
 */
export function settled(run: ScheduleRun): boolean {
  return run.state !== "claimed" && run.state !== "running";
}

/**
 * The run this schedule has in flight, if any — the one *Stop the run* acts
 * on.
 *
 * **`running` and holding a session, not merely `claimed`.** A claimed run is
 * still being launched: there is no agent yet and no workspace, so there is
 * nothing to stop, and the teardown it would call has nothing to act on. The
 * control offered itself for a run that never started.
 */
export function inFlight(runs: ScheduleRun[]): ScheduleRun | undefined {
  return runs.find((r) => r.state === "running" && !!r.sessionId);
}

/**
 * Whether anything about this schedule is still moving.
 *
 * What the page polls on. A claimed run counts: it is the window where the
 * client knows least and the server is about to know more.
 */
export function stillMoving(runs: ScheduleRun[]): boolean {
  return runs.some((r) => !settled(r));
}

/**
 * When it ran, as the row prints it.
 *
 * `HH:MM` and nothing finer, which is the whole reason the sweep's interval
 * is not worth tightening: at sixty seconds the row says 09:00, and at thirty
 * it says 09:00.
 */
export function ran(at: string): string {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return "—";
  const today = new Date();
  const sameDay = when.toDateString() === today.toDateString();
  const yesterday = new Date(today.getTime() - 86_400_000).toDateString() === when.toDateString();
  const clock = when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  if (sameDay) return `today ${clock}`;
  if (yesterday) return `yesterday ${clock}`;
  return `${when.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${clock}`;
}

/** How long it took. An em dash where no agent started — there is no duration
 *  to report, and a zero would claim there was. */
export function took(run: ScheduleRun): string {
  if (!run.launchedAt || !run.endedAt) return "—";
  const ms = Date.parse(run.endedAt) - Date.parse(run.launchedAt);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${String(secs % 60).padStart(2, "0")}s`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * A fire time that has not happened yet.
 *
 * **It always says which day.** A weekday and a clock is enough for a daily
 * or a weekly schedule and says nothing at all for a monthly one: the create
 * sheet read "Mon 08:30, Mon 08:30, Mon 08:30" for three dates a month
 * apart, which is three times the same non-answer. *Today* and *tomorrow*
 * are the two days worth naming in words; everything else takes its date.
 *
 * One helper for both the sheet and the schedule's own page, because they
 * were drawing the same fact two ways and only one of them was right.
 */
export function fires(at: string): string {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return "—";
  const clock = when.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const today = new Date();
  if (when.toDateString() === today.toDateString()) return `today ${clock}`;
  const soon = new Date(today.getTime() + 86_400_000);
  if (when.toDateString() === soon.toDateString()) return `tomorrow ${clock}`;
  return `${when.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  })} ${clock}`;
}

/** The next run, as the row prints it. */
export function nextRun(trigger: Trigger | undefined): string {
  return trigger?.nextFireAt ? fires(trigger.nextFireAt) : "—";
}

/**
 * What a schedule's own glyph is, in the panel where there is no column to
 * say what the mark refers to.
 *
 * On the list the lead mark is the **last run's outcome**, because the row
 * sits under a *Last run* column that says what it refers to. Here there is
 * no column, so the mark is the schedule's own state.
 */
export function outcomeOf(run: ScheduleRun | null | undefined): Outcome | null {
  return run?.outcome ?? null;
}

export function stateOf(run: ScheduleRun | null | undefined): ScheduleRunState | null {
  return run?.state ?? null;
}
