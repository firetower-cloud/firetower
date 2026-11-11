/**
 * One schedule, opened.
 *
 * The skill detail's shape: a head, the thing itself, and a rail of facts
 * cards beside it.
 *
 * Three things on this screen are decisions rather than layout.
 *
 * **Pausing the clock and stopping a run are two controls.** *Stop the run*
 * is present only while one is going, and pausing never touches it. A
 * schedule that paused itself with a run still going is the shape of the
 * overrun stop, and it is the reason these cannot be one button.
 *
 * **A refused run is drawn as a fact, not an error.** Nothing broke: the
 * schedule is on, its clock is untouched, and the next occurrence will be
 * attempted. So no triangle, no banner — a banner is what *Firetower stopped
 * this schedule* gets, and that is a state change, which this is not. And
 * nothing in it is pressable, because there is nothing to offer: no view of
 * workspaces by machine and no control to free space. A refusal that offers
 * nothing is a legitimate thing to ship; dressing it as though it offers
 * something is not.
 *
 * **The count of kept workspaces is drawn in both switch states.** There is
 * no cap and no ceiling. With nothing deleting to make room, this number is
 * the only thing that says whether somebody's machines are filling.
 */
import { useMemo } from "react";
import { ArrowUpRight, MoreHorizontal, Pencil, ShieldAlert, Square, TriangleAlert } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Icon, IconButton } from "~/components/ui";
import { WhereTo } from "~/ui/config/bits";
import { navigate } from "~/shims/next-navigation";
import { useConfirm } from "~/ui/Confirm";
import { ContextMenu, useMenu, type MenuItem } from "~/ui/ContextMenu";
import {
  deleteSchedule,
  getListSchedulesQueryKey,
  pauseSchedule,
  resumeSchedule,
  approveSchedule,
  useScheduleRuns,
} from "~/api/generated/schedules/schedules";
import { destroySession, sessionWork } from "~/api/generated/sessions/sessions";
import type { Schedule, ScheduleRun } from "~/api/generated/model";
import { BackToSchedules, RunNowButton, saysWhen } from "./SchedulesPage";
import { RunMark, keptWhy, ran, runLine, took } from "./view";
import { pauseSays, stoppedByFiretower } from "./words";

export function ScheduleDetail({ schedule }: { schedule: Schedule }) {
  const client = useQueryClient();
  const confirm = useConfirm();
  const menu = useMenu<Schedule>();
  const history = useScheduleRuns(schedule.id, { limit: 20 });
  const runs = useMemo(() => history.data ?? [], [history.data]);

  const refresh = () => client.invalidateQueries({ queryKey: getListSchedulesQueryKey() });
  const trigger = schedule.triggers[0];
  const norepo = !schedule.repoId;
  /* Nothing is deleted automatically when the switch is off, and also when
     there is no repository to tell a clean run from a dirty one. Both keep
     everything, and both show the count. */
  const keepall = !schedule.deleteCleanRuns || norepo;
  const live = runs.find((r) => r.state === "running" || r.state === "claimed");
  const refused = runs[0]?.state === "refused" ? runs[0] : null;
  const said = pauseSays(schedule, machineNamed(runs));

  const items: MenuItem[] = [
    {
      label: "Delete",
      tone: "danger",
      onPick: async () => {
        const sure = await confirm({
          title: `Delete ${schedule.name}?`,
          body: live
            ? "The schedule stops. Its run history is deleted and cannot be recovered. One run is in progress — it will finish and its workspace stays. To stop it, close this and use Stop the run."
            : "The schedule stops. Its run history is deleted and cannot be recovered. Workspaces from past runs are not affected.",
          action: "Delete schedule",
          tone: "danger",
        });
        if (!sure) return;
        await deleteSchedule(schedule.id);
        await refresh();
        navigate("/schedules");
      },
    },
  ];

  return (
    <div className="scroll">
      <div className="pg">
        <BackToSchedules />

        <div className="s-head">
          <div>
            <h1>{schedule.name}</h1>
            <p className="sub">
              {saysWhen(schedule)}.
              {schedule.active ? "" : stoppedByFiretower(schedule) ? " Stopped by Firetower." : " Paused."}
            </p>
          </div>
          <div className="acts">
            {/* **Stopping a run and pausing the clock are two controls**, and
                this one is only here while a run is going. Pausing never
                touches a run in flight — the schedule that paused itself with
                a run still going is the shape of the overrun stop, and it is
                why these cannot be one button.

                It ends the agent in this run, not the workspace: what it
                leaves behind is the thing somebody opens afterwards to find
                out why it would not finish. */}
            {live ? (
              <button
                className="btn plain"
                title="Stops this run and any agents it started. The workspace stays."
                onClick={async () => {
                  if (!live.sessionId) return;
                  const work = await sessionWork(live.sessionId).catch(() => []);
                  const uncommitted = work.reduce((n, c) => n + (c.uncommitted ?? 0), 0);
                  const sure = await confirm({
                    title: "Stop this run?",
                    body: uncommitted
                      ? `The agent stops and its workspace stays, with ${uncommitted} uncommitted file${uncommitted === 1 ? "" : "s"} in it. The schedule is unchanged and will run again at its usual time.`
                      : "The agent stops and its workspace stays. The schedule is unchanged and will run again at its usual time.",
                    action: "Stop the run",
                  });
                  if (!sure) return;
                  await destroySession(live.sessionId, { workspace: false });
                  history.refetch();
                  await refresh();
                }}
              >
                <Icon of={Square} size={14} />
                Stop the run
              </button>
            ) : (
              <RunNowButton schedule={schedule} onDone={() => history.refetch()} />
            )}
            <button className="btn plain" onClick={() => navigate(`/schedules/${schedule.id}?edit=1`)}>
              <Icon of={Pencil} size={14} />
              Edit
            </button>
            <span
              className="tog"
              role="switch"
              aria-checked={schedule.active}
              tabIndex={0}
              title={schedule.active ? "Pause future runs" : "Turn it on"}
              onClick={async () => {
                if (schedule.active) await pauseSchedule(schedule.id);
                else if (schedule.approvedAt) await resumeSchedule(schedule.id);
                else await approveSchedule(schedule.id);
                await refresh();
              }}
            >
              <i />
            </span>
            <span className="text-body text-dim">{schedule.active ? "On" : "Off"}</span>
            <IconButton of={MoreHorizontal} label="More" onClick={(e) => menu.show(e, schedule)} />
          </div>
        </div>

        {/* **It cannot run.** In brick, leading with the fix. A different
            thing from a schedule that stopped itself, which is amber. */}
        {schedule.active && cannotRun(schedule, runs) && (
          <div className="s-conseq" data-tone="brick">
            <Icon of={TriangleAlert} size={16} />
            <div>
              <p>{cannotRun(schedule, runs)}</p>
            </div>
          </div>
        )}

        {said && (
          <div className="s-conseq" data-tone="amber">
            <Icon of={ShieldAlert} size={16} />
            <div>
              <p>
                <b>{said.headline}</b>
              </p>
              <p>{said.because}</p>
            </div>
          </div>
        )}

        <div className="s-two">
          <div>
            <div>
              <h2 className="s-h3">Prompt</h2>
              <div className="s-prompt">{schedule.prompt}</div>
            </div>

            <div className="s-blk">
              <h2 className="s-h3">Schedule</h2>
              <p className="s-reads">
                {trigger?.reads} <span className="mono">{trigger?.timezone}</span>
                {schedule.active && (trigger?.nextFires ?? []).length > 0 ? (
                  <span className="s-fires">
                    Next three runs: {(trigger?.nextFires ?? []).map((f) => ran(f)).join(", ")}.
                  </span>
                ) : (
                  <span className="s-fires">Will not run until you turn it on.</span>
                )}
                <Travelling zone={trigger?.timezone} />
              </p>
            </div>

            <div className="s-blk">
              <h2 className="s-h3">
                Run history <span className="n">{schedule.runsTotal}</span>
              </h2>
              <History runs={runs} norepo={norepo} keepall={keepall} total={schedule.runsTotal} />
              {refused && refused.errorCode === "NoCapacity" && (
                <WhereTo className="mt-[22px]">
                  <b>Runs are being refused rather than started.</b> Nothing is deleted to make
                  room. A refused run is not a failure, so this is not moving the schedule towards
                  pausing itself, and the next run will be attempted at its usual time.
                </WhereTo>
              )}
            </div>
          </div>

          <aside>
            <Facts
              title="Environment"
              rows={[
                ["Repository", schedule.repoSlug ?? "None"],
                ["Base branch", schedule.base ?? "—"],
                ["Machine", "First available"],
              ]}
            />
            <div className="facts-card">
              <h3>When a run cannot finish</h3>
              <dl>
                <dt>If approval is needed</dt>
                <dd>The action is blocked. The run carries on.</dd>
                <dt>If the agent needs you</dt>
                <dd>
                  After 15 minutes it stops waiting. The workspace stays open and the question is
                  kept, so you can still answer it.
                </dd>
                <dt>If a run is missed</dt>
                <dd>
                  A run whose time passes while Firetower is down is recorded as missed. It is never
                  run late.
                </dd>
                <dt>If a run overruns</dt>
                <dd>
                  It is never stopped. The next run is skipped, and a second overrun pauses the
                  schedule.
                </dd>
                <dt>If a machine is low on disk</dt>
                <dd>
                  The run is refused and nothing starts. It does not count as a failure, so this
                  never pauses the schedule.
                </dd>
              </dl>
            </div>

            <div className="facts-card">
              <h3>Workspace</h3>
              <dl>
                <dt>Created</dt>
                <dd>New for each run</dd>
                <dt>Visible to</dt>
                <dd>Only you</dd>
              </dl>
              {norepo ? (
                <div className="s-pop" data-k="kept">
                  <div className="s-poph">
                    <b>Kept</b>
                    <span>{schedule.workspacesKept} open</span>
                  </div>
                  <span className="line warn">
                    <i />
                    Every run, however it ends
                  </span>
                  <p className="s-cardnote">
                    Nothing is checked out, so git never sees this workspace and cannot say what a
                    run left in it. Deleting one would delete every file the agent made. Nothing
                    here is deleted automatically.
                  </p>
                </div>
              ) : schedule.deleteCleanRuns ? (
                <>
                  <div className="s-pop" data-k="gone">
                    <div className="s-poph">
                      <b>Deleted</b>
                      <span>as each run finishes</span>
                    </div>
                    <span className="line ok">
                      <i />A run that finished clean
                    </span>
                    <p className="s-cardnote">
                      The workspace and its conversation go inside a minute. The run history line
                      stays.
                    </p>
                  </div>
                  <div className="s-pop" data-k="kept">
                    <div className="s-poph">
                      <b>Kept</b>
                      <span data-loud={!!refused}>{schedule.workspacesKept} open</span>
                    </div>
                    <span className="line warn">
                      <i />A run that failed
                    </span>
                    <span className="line warn">
                      <i />A run that stopped because it needed you
                    </span>
                    <span className="line warn">
                      <i />A run that left files uncommitted or unpushed
                    </span>
                    <span className="line warn">
                      <i />A run whose machine could not be reached when it finished
                    </span>
                    <p className="s-cardnote">
                      Nothing bounds this. Each kept workspace holds between 0.5 and 2&nbsp;GB on
                      its machine. When a machine runs low, runs are refused instead of started, and
                      nothing is deleted to make room. <b>This count is the only warning.</b>
                    </p>
                  </div>
                </>
              ) : (
                <div className="s-pop" data-k="kept">
                  <div className="s-poph">
                    <b>Kept</b>
                    <span>{schedule.workspacesKept} open</span>
                  </div>
                  <span className="line warn">
                    <i />
                    Every run, clean or not
                  </span>
                  <p className="s-cardnote">
                    Nothing is deleted automatically and nothing bounds the total. One run&rsquo;s
                    conversation has measured 9.3&nbsp;MB.
                  </p>
                </div>
              )}
            </div>

            <Facts
              title="Who made it"
              rows={
                schedule.made.byAgent
                  ? [
                      ["Proposed by", schedule.made.who],
                      ["In", schedule.made.fromWorkspaceName ?? "a conversation"],
                    ]
                  : [["Made by", "You"]]
              }
            />
          </aside>
        </div>
      </div>
      {menu.open && <ContextMenu at={menu.open.at} items={items} onClose={menu.close} />}
    </div>
  );
}

/**
 * The run history, twenty rows.
 *
 * **It survives its workspace being deleted.** The line, the outcome, the
 * timing and the summary are on the run rather than joined from the session,
 * so a purged workspace leaves the row exactly as it was. The arrow is the
 * whole difference somebody can act on — a row with one opens a workspace, a
 * row without one is a record and nothing more — and it is drawn rather than
 * left to hover, because a tooltip is not an affordance on a surface that can
 * be touched.
 */
function History({
  runs,
  norepo,
  keepall,
  total,
}: {
  runs: ScheduleRun[];
  norepo: boolean;
  keepall: boolean;
  total: number;
}) {
  if (runs.length === 0) {
    return <p className="s-foot-note">No runs yet. It will not run until you turn it on.</p>;
  }
  return (
    <>
      <div className="colhead">
        <span className="w-4" />
        <span className="flex-1">What the run did</span>
        <span className="w-[132px]">Ran</span>
        <span className="w-[80px]">Took</span>
        <span className="w-5" />
      </div>
      <div className="s-runs">
        {runs.map((r) => (
          <button
            className="s-run"
            key={r.id}
            data-gone={!r.workspaceKept}
            title={keptWhy(r, { norepo, keepall })}
            onClick={() => r.workspaceKept && r.sessionId && navigate(`/sessions/${r.sessionId}`)}
          >
            <span className="g">
              <RunMark run={r} />
            </span>
            <span className="flex-1">{runLine(r)}</span>
            <span className="w-[132px] tabular-nums">{ran(r.fireAt)}</span>
            <span className="w-[80px] tabular-nums">{took(r)}</span>
            <span className="w-5">
              {r.workspaceKept && r.sessionId ? <Icon of={ArrowUpRight} size={14} /> : null}
            </span>
          </button>
        ))}
      </div>
      <p className="s-foot-note">
        Showing the last {runs.length} of {total} runs.{" "}
        {norepo
          ? "Without a repository, runs are not summarised. The outcome and the timing are still kept."
          : "Each line is the agent’s own summary, written when it hands back. A run without one shows what git can see instead."}{" "}
        A row with an arrow still has a workspace to open.
      </p>
    </>
  );
}

function Facts({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div className="facts-card">
      <h3>{title}</h3>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * The schedule keeps its own zone when this computer is somewhere else.
 *
 * Said rather than converted: a schedule set for Europe/Paris runs at 07:00
 * in Paris whatever the laptop reading it thinks the time is, and the row has
 * to say what that means where you are standing.
 */
function Travelling({ zone }: { zone?: string }) {
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!zone || !here || here === zone) return null;
  return (
    <span className="s-fires text-[var(--color-amber)]">
      This computer is set to {here}. The schedule keeps {zone}.
    </span>
  );
}

/**
 * Why this one cannot run, when the history says so plainly.
 *
 * Leads with the fix. Derived from the last run rather than stored, for the
 * same reason the pause sentence is.
 */
function cannotRun(schedule: Schedule, runs: ScheduleRun[]): string | null {
  const last = runs.find((r) => r.state === "failed");
  if (!last) return null;
  if (last.errorCode === "RepoNotConnected") {
    return `Cannot run: ${schedule.repoSlug ?? "the repository"} is not connected. There is nothing to check out — reconnect it on the Repositories screen, or point this schedule at a different one.`;
  }
  if (last.errorCode === "HostUnreachable" && last.hostName) {
    return `Cannot run: ${last.hostName} is not responding. Turn it back on, or set this schedule to use the first available machine.`;
  }
  return null;
}

/** The machine every failure in the streak named, when they all named one. */
function machineNamed(runs: ScheduleRun[]): string | null {
  const named = runs
    .filter((r) => r.errorCode === "HostUnreachable")
    .map((r) => r.hostName)
    .filter((n): n is string => !!n);
  if (named.length === 0) return null;
  return named.every((n) => n === named[0]) ? named[0] : null;
}
