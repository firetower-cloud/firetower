/**
 * An agent proposed this, and it is off until a person turns it on.
 *
 * Modelled on the held skill: an amber box that names the risk, a summary of
 * what would run, then Approve beside Discard.
 *
 * **All of the consequences, not four.** On the create sheet the schedule,
 * the repository, the machine and the agent are set by controls six inches
 * above the summary, so repeating them there would be the same fact in a
 * control, a label and a summary. Here nothing on the screen sets any of
 * them, and the person reading it did not write it — so the summary says
 * everything it would do.
 *
 * **Pinned above the footer.** What somebody is deciding is at the bottom of
 * a scrolling page otherwise, and the decision is the point of the screen.
 */
import { Check, Pencil, ShieldAlert, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Icon } from "~/components/ui";
import { navigate } from "~/shims/next-navigation";
import {
  approveSchedule,
  deleteSchedule,
  getListSchedulesQueryKey,
} from "~/api/generated/schedules/schedules";
import type { Schedule } from "~/api/generated/model";
import { BackToSchedules, saysWhen } from "./SchedulesPage";

export function Review({ schedule }: { schedule: Schedule }) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: getListSchedulesQueryKey() });
  const trigger = schedule.triggers[0];

  return (
    <div className="scroll">
      <div className="pg">
        <BackToSchedules />

        <div className="s-head">
          <div>
            <h1>{schedule.name}</h1>
            <p className="sub">Proposed by {schedule.made.who}. It has never run.</p>
          </div>
        </div>

        <div className="s-conseq" data-tone="amber">
          <Icon of={ShieldAlert} size={16} />
          <div>
            <p>
              <b>An agent proposed this schedule. It is off until you turn it on.</b>
            </p>
            <p>
              Turning it on lets an agent change files and run commands on your account, without you
              present.
            </p>
          </div>
        </div>

        <div className="s-two">
          <div>
            <div className="s-blk">
              <div className="s-sumbox">
                <h3>What it would do</h3>
                <dl className="s-sum">
                  <dt>Schedule</dt>
                  <dd>
                    {trigger?.reads} {trigger?.timezone}
                  </dd>
                  <dt>Repository</dt>
                  <dd>{schedule.repoSlug ?? "None — nothing is checked out"}</dd>
                  <dt>Machine</dt>
                  <dd>First available</dd>
                  <dt>Workspace</dt>
                  <dd>
                    {schedule.deleteCleanRuns
                      ? "A new one for each run, deleted as that run finishes. Kept instead if the run failed, needed you, or left work uncommitted. Nothing bounds how many are kept."
                      : "A new one for each run, kept until you delete it. Nothing bounds how many are kept."}
                  </dd>
                  <dt>Runs as</dt>
                  <dd>You, on your own subscription</dd>
                  <dt>Access</dt>
                  <dd>
                    Edits files and runs commands without you present.
                    {schedule.repoId ? " Can use this repository’s secrets." : ""}
                  </dd>
                  <dt>If approval is needed</dt>
                  <dd>The action is blocked. The run carries on.</dd>
                  <dt>If the agent needs you</dt>
                  <dd>
                    After 15 minutes it stops waiting. The workspace stays open, so you can still
                    answer.
                  </dd>
                  <dt>If a run is missed</dt>
                  <dd>
                    A run whose time passes while Firetower is down is recorded as missed. It is
                    never run late.
                  </dd>
                  <dt>If a machine is low on disk</dt>
                  <dd>The run is refused and nothing starts. Nothing is deleted to make room.</dd>
                </dl>
              </div>
            </div>

            <div className="s-blk">
              <h2 className="s-h3">Prompt</h2>
              <div className="s-prompt">{schedule.prompt}</div>
            </div>

            <div className="s-blk flex flex-wrap items-center gap-2">
              <button
                className="btn"
                style={{
                  background: "var(--color-sage-tint)",
                  color: "var(--color-sage)",
                  fontWeight: 500,
                  boxShadow: "inset 0 0 0 1px var(--color-sage-deep)",
                }}
                onClick={async () => {
                  // **The revision this screen drew.** Open a proposal in one
                  // tab, edit it in another, and approving the stale one
                  // would authorize changes nobody read. The server refuses
                  // when it has moved.
                  await approveSchedule(schedule.id, { revision: schedule.revision });
                  await refresh();
                }}
              >
                <Icon of={Check} size={16} />
                Approve &amp; turn on
              </button>
              <button
                className="btn danger"
                onClick={async () => {
                  await deleteSchedule(schedule.id);
                  await refresh();
                  navigate("/schedules");
                }}
              >
                <Icon of={Trash2} size={16} />
                Discard
              </button>
              <button className="btn quiet" onClick={() => navigate(`/schedules/${schedule.id}?edit=1`)}>
                <Icon of={Pencil} size={16} />
                Edit
              </button>
            </div>
          </div>

          <aside>
            <div className="facts-card">
              <h3>Where it came from</h3>
              <dl>
                <dt>Proposed by</dt>
                <dd className="s-wrap" title={schedule.made.who}>
                  {schedule.made.who}
                </dd>
                {/* The conversation that asked for it, which is what explains
                    why you have this at all. Copied text rather than a link
                    that `reclaim` would empty within the minute — and it
                    wraps, because a workspace name loses its meaning from
                    the end. */}
                <dt>In</dt>
                <dd className="s-wrap">{schedule.made.fromWorkspaceName ?? "a conversation"}</dd>
              </dl>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
