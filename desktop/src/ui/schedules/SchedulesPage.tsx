/**
 * The library, and everything reached from it.
 *
 * **One list, two sections.** *Waiting for you* leads — a proposal an agent
 * made, or a schedule Firetower stopped — and *Your schedules* is the rest,
 * in the order they next run. The list does not reorder when a switch is
 * flipped: a list that rearranges itself under your hand is the
 * status-grouping mistake already rejected for the workspaces panel.
 *
 * **A row carries one time.** Both times are named columns instead, which is
 * what makes two timestamps on one row legible rather than a house-rule
 * break: *Next run* and *Last run*, written once over the table.
 *
 * **The empty state is the examples.** No illustration, no sentence about
 * emptiness — eight things a team would actually put on a clock, and a way to
 * start from one.
 */
import { useMemo, useState } from "react";
import { ArrowLeft, Clock, MoreHorizontal, Play, Plus } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Icon, IconButton } from "~/components/ui";
import { Section, WhereTo } from "~/ui/config/bits";
import { ContextMenu, useMenu, type MenuItem } from "~/ui/ContextMenu";
import { useConfirm } from "~/ui/Confirm";
import { navigate } from "~/shims/next-navigation";
import {
  useListSchedules,
  useAllRuns,
  getListSchedulesQueryKey,
  deleteSchedule,
  pauseSchedule,
  resumeSchedule,
  approveSchedule,
  runScheduleNow,
} from "~/api/generated/schedules/schedules";
import type { Schedule } from "~/api/generated/model";
import { EXAMPLES, type Example } from "./examples";
import { NewSchedule } from "./NewSchedule";
import { ScheduleDetail } from "./ScheduleDetail";
import { Review } from "./Review";
import { RunMark, nextRun, ran, runLine, took } from "./view";
import { offWord, pauseTag, stoppedByFiretower } from "./words";

export function SchedulesPage({ open, runs }: { open?: string | null; runs?: boolean }) {
  const library = useListSchedules();
  const everything = useMemo(() => library.data ?? [], [library.data]);
  /* `?new=1` is how the panel's own row opens the sheet: it is over this
     screen, so the row has to land here and then open it. Read once, on the
     way in — afterwards the sheet is this component's state like any other. */
  const [making, setMaking] = useState<Example | null | false>(() =>
    typeof window !== "undefined" && window.location.hash.includes("new=1") ? null : false,
  );

  const opened = open ? everything.find((s) => s.id === open) : undefined;
  if (open && opened) {
    /* A proposal is a different screen from a schedule: it is about deciding
       rather than about reading, and nothing on it is a control until it has
       been turned on. */
    return opened.made.byAgent && !opened.approvedAt ? (
      <Review schedule={opened} />
    ) : (
      <ScheduleDetail schedule={opened} />
    );
  }

  return (
    <>
      {runs ? <AllRuns /> : <Library library={library} schedules={everything} onNew={setMaking} />}
      {making !== false && <NewSchedule from={making} onClose={() => setMaking(false)} />}
    </>
  );
}

function Library({
  library,
  schedules,
  onNew,
}: {
  library: ReturnType<typeof useListSchedules>;
  schedules: Schedule[];
  onNew: (from: Example | null) => void;
}) {
  /* **Waiting for you**: a proposal nobody has looked at, and a schedule
     Firetower stopped. Both want a decision, which is the whole of what this
     section means — it is not "anything unusual". */
  const waiting = schedules.filter((s) => (s.made.byAgent && !s.approvedAt) || stoppedByFiretower(s));
  const mine = schedules.filter((s) => !waiting.includes(s));
  const proposals = waiting.filter((s) => s.made.byAgent && !s.approvedAt).length;

  return (
    <div className="scroll">
      <Section
        title="Schedules"
        note="Run an agent on a schedule. Each run starts a new workspace and follows the prompt you set."
        action={
          <button className="btn primary" onClick={() => onNew(null)}>
            <Icon of={Plus} size={16} />
            New schedule
          </button>
        }
        settling={library.isPending}
        error={library.error ? "That did not load." : null}
        trouble={library.error ? "error" : null}
        onRetry={() => library.refetch()}
      >
        {schedules.length === 0 ? (
          <Examples first onPick={onNew} />
        ) : (
          <>
            {waiting.length > 0 && (
              <section className="lsec">
                <h2>
                  Waiting for you <span className="n">{waiting.length}</span>
                </h2>
                {proposals > 0 && (
                  <div className="review">
                    <h3>Proposed by an agent</h3>
                    <p>
                      These are off until you turn them on. Check the repository, the account and
                      what the agent is asked to do before you approve.
                    </p>
                  </div>
                )}
                <ColumnHeads />
                <div className="lrows">
                  {waiting.map((s) => (
                    <Row key={s.id} schedule={s} />
                  ))}
                </div>
              </section>
            )}

            <section className="lsec">
              <h2>
                Your schedules <span className="n">{mine.length}</span>
              </h2>
              <ColumnHeads />
              <div className="lrows">
                {mine.map((s) => (
                  <Row key={s.id} schedule={s} />
                ))}
              </div>
            </section>

            <Examples onPick={onNew} />
          </>
        )}

        <WhereTo>
          Schedules run as <b>you</b>. The agent uses your subscription and pushes with your git
          token. You cannot share a schedule or file it in a directory.
        </WhereTo>
      </Section>
    </div>
  );
}

/**
 * The names over the two columns.
 *
 * Once per table, and both tables get one: an unlabelled second time cell is
 * the thing this is fixing.
 */
function ColumnHeads() {
  return (
    <div className="colhead">
      <span className="w-4" />
      <span className="flex-1">Schedule</span>
      <span className="w-[132px]">Next run</span>
      <span className="w-[108px]">Last run</span>
      <span className="w-[76px]" />
    </div>
  );
}

function Row({ schedule }: { schedule: Schedule }) {
  const client = useQueryClient();
  const menu = useMenu<Schedule>();
  const confirm = useConfirm();
  const tag = pauseTag(schedule);
  const trigger = schedule.triggers[0];

  const refresh = () => client.invalidateQueries({ queryKey: getListSchedulesQueryKey() });

  const flip = async () => {
    if (schedule.active) await pauseSchedule(schedule.id);
    else if (schedule.approvedAt) await resumeSchedule(schedule.id);
    else await approveSchedule(schedule.id);
    await refresh();
  };

  const items: MenuItem[] = [
    { label: schedule.active ? "Pause future runs" : "Turn it on", onPick: flip },
    {
      label: "Run now",
      /* It leaves the clock where it is, and the run is marked `manual` — so
         three presses that each ask something cannot pause a schedule that
         has never failed on its own clock. */
      disabled: !schedule.approvedAt,
      onPick: async () => {
        await runScheduleNow(schedule.id);
        await refresh();
      },
    },
    "-",
    {
      label: "Delete",
      tone: "danger",
      onPick: async () => {
        const sure = await confirm({
          title: `Delete ${schedule.name}?`,
          /* Says what stops, what is deleted, and what carries on. The run in
             flight is the fact somebody would otherwise discover afterwards. */
          body: "The schedule stops. Its run history is deleted and cannot be recovered. Workspaces from past runs are not affected, and a run in progress carries on — to stop that, use Stop the run first.",
          action: "Delete schedule",
          tone: "danger",
        });
        if (!sure) return;
        await deleteSchedule(schedule.id);
        await refresh();
      },
    },
  ];

  return (
    <>
      <button
        className="r"
        data-off={!schedule.active}
        onClick={() => navigate(`/schedules/${schedule.id}`)}
        title={`${schedule.name}. ${trigger?.reads ?? ""}`}
      >
        <span className="g">{schedule.lastRun ? <RunMark run={schedule.lastRun} /> : null}</span>
        <span className="tx flex-1">
          <b>{schedule.name}</b>
          <s>{saysWhen(schedule)}</s>
        </span>
        {/* **The tag carries the reason, because the column already carries
            the fact.** One you paused reads *Paused* under *Next run*; one
            Firetower stopped reads *Stopped*. So who did it is answered by
            honest layout, and the tag is free to say why — which is what
            somebody needs, because the remedy differs. */}
        {tag && <span className="s-tag">{tag}</span>}
        {schedule.made.byAgent && !schedule.approvedAt && (
          <span className="s-tag">Proposed by an agent</span>
        )}
        <span className="w-[132px] tabular-nums">
          {schedule.active ? nextRun(trigger) : offWord(schedule)}
        </span>
        <span className="w-[108px] tabular-nums">
          {schedule.lastRun ? ran(schedule.lastRun.fireAt) : "—"}
        </span>
        <span
          className="tog"
          aria-checked={schedule.active}
          role="switch"
          tabIndex={0}
          title={schedule.active ? "Pause future runs" : "Turn it on"}
          onClick={async (e) => {
            e.stopPropagation();
            await flip();
          }}
        >
          <i />
        </span>
        <IconButton
          of={MoreHorizontal}
          label="More"
          className="hov"
          onClick={(e) => menu.show(e, schedule)}
        />
      </button>
      {menu.open && <ContextMenu at={menu.open.at} items={items} onClose={menu.close} />}
    </>
  );
}

/** What a row says under the name: the cadence, in the server's words. */
export function saysWhen(schedule: Schedule): string {
  const trigger = schedule.triggers[0];
  if (!trigger) return "No trigger";
  return `${trigger.reads} ${trigger.timezone}`;
}

function Examples({ first, onPick }: { first?: boolean; onPick: (e: Example) => void }) {
  return (
    <section className="lsec">
      <h2>
        Start from an example <span className="n">{EXAMPLES.length}</span>
      </h2>
      <p className="note">
        {first
          ? "Nothing is on a clock yet. Each of these is a prompt, a cadence, and what the run leaves behind — start from one and change it."
          : "Each is a prompt and a cadence. Starting from one opens the sheet with it filled in."}
      </p>
      <div className="s-egs">
        {EXAMPLES.map((e) => (
          <button className="s-eg" key={e.name} onClick={() => onPick(e)}>
            <span className="ic">
              <Icon of={Clock} size={16} />
            </span>
            <b>{e.name}</b>
            <s>{e.says}</s>
            <p>{e.does}</p>
            <span className="makes">{e.makes}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * Every run from every schedule, newest first, banded by day.
 *
 * A page behind a row in the panel rather than a scope behind a switch, and
 * built from the same rows each schedule's own history draws — so the two
 * cannot disagree about what happened.
 *
 * **There was a filter here for one round and it is gone.** It read *Still
 * holding a workspace* and was the destination of a link from a refused run —
 * the remedy half of the disk floor. It is out of scope by ruling, and
 * removing it is the point rather than an omission: it listed only scheduled
 * workspaces, so the machine it pointed at could be full of work the list
 * never showed.
 */
function AllRuns() {
  const feed = useAllRuns({ limit: 50 });
  const runs = useMemo(() => feed.data ?? [], [feed.data]);
  const bands = useMemo(() => {
    const today: typeof runs = [];
    const yesterday: typeof runs = [];
    const earlier: typeof runs = [];
    const now = new Date();
    for (const r of runs) {
      const when = new Date(r.fireAt);
      if (when.toDateString() === now.toDateString()) today.push(r);
      else if (new Date(now.getTime() - 86_400_000).toDateString() === when.toDateString())
        yesterday.push(r);
      else earlier.push(r);
    }
    return [
      ["Today", today],
      ["Yesterday", yesterday],
      ["Earlier", earlier],
    ] as const;
  }, [runs]);

  return (
    <div className="scroll">
      <Section
        title="All runs"
        note="Every run from every schedule, newest first."
        settling={feed.isPending}
      >
        {bands
          .filter(([, rows]) => rows.length > 0)
          .map(([band, rows]) => (
            <section className="lsec" key={band}>
              <h2>
                {band} <span className="n">{rows.length}</span>
              </h2>
              <div className="colhead">
                <span className="w-4" />
                <span className="flex-1">Schedule, and what the run did</span>
                <span className="w-[132px]">Ran</span>
                <span className="w-[80px]">Took</span>
              </div>
              <div className="lrows">
                {rows.map((r) => (
                  <button
                    className="r"
                    key={r.id}
                    onClick={() => navigate(`/schedules/${r.scheduleId}`)}
                    title={runLine(r)}
                  >
                    <span className="g">
                      <RunMark run={r} />
                    </span>
                    <span className="tx flex-1">
                      <b>{r.scheduleName}</b>
                      <s>{runLine(r)}</s>
                    </span>
                    <span className="w-[132px] tabular-nums">{ran(r.fireAt)}</span>
                    <span className="w-[80px] tabular-nums">{took(r)}</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        {runs.length === 0 && <p className="note">Nothing has run yet.</p>}
        <p className="s-foot-note">
          A row with an arrow still has a workspace to open. The rest are records: the workspace was
          deleted after the run, or no workspace was started.
        </p>
      </Section>
    </div>
  );
}

/** The way back, for a detail screen. */
export function BackToSchedules() {
  return (
    <button className="out" onClick={() => navigate("/schedules")}>
      <Icon of={ArrowLeft} size={14} />
      Schedules
    </button>
  );
}

/** Start one now, where a run is not already going. */
export function RunNowButton({ schedule, onDone }: { schedule: Schedule; onDone: () => void }) {
  return (
    <button
      className="btn plain"
      disabled={!schedule.approvedAt}
      title="Starts a run now. The schedule is unchanged, and the run waits if it needs you."
      onClick={async () => {
        await runScheduleNow(schedule.id);
        onDone();
      }}
    >
      <Icon of={Play} size={14} />
      Run now
    </button>
  );
}
