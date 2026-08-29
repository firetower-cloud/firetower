"use client";

/**
 * Everything you have, and what to do about all of it.
 *
 * The workbench replaced the sessions list and nothing replaced what the list
 * was *for*. It was doing four jobs: showing the fleet, saying what needed you,
 * ending all of it, and being the way to Repos, Agents, Secrets and Compute.
 * Only the first survived, squeezed into a rail — a hundred pixels wide, inside
 * a workspace you are already in, and scrolling. That is a switcher, not an
 * overview, which is why forty-eight runs felt unmanageable.
 *
 * So: **home is about the fleet, a workspace is about the work.** It is a page
 * like Repos or Agents, inside the same rail they have — Sessions, and the four
 * others, and what is in flight, and the hosts. The workbench is the only thing
 * that takes the whole window, because it is the only thing that needs it.
 */

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Waypoints } from "lucide-react";
import {
  getListSessionsQueryKey,
  useEndAllSessions,
  useListSessions,
} from "@/src/api/generated/sessions/sessions";
import { AgentMark, AGENT_SHORT } from "@/components/AgentMark";
import { Modal } from "@/components/Modal";
import { NewWorkspace } from "@/components/NewWorkspace";
import { Signal } from "@/components/Signal";
import {
  Badge,
  Button,
  Card,
  CardHead,
  Columns,
  Empty,
  GithubMark,
  List,
  PageHead,
  Row,
  Segmented,
  Select,
} from "@/components/ui";
import { elapsed, minutesSince, needsYou } from "@/src/api/view";
import { doing, group, type Workspace } from "@/src/api/workspaces";

/** One set of widths, shared by the legend and every row under it. */
const COL = {
  lead: "w-[15px] shrink-0",
  agents: "w-[92px] shrink-0",
  when: "w-[64px] shrink-0",
  state: "w-[84px] shrink-0",
};

/** What a workspace can be doing, as the filter says it. */
type Doing = ReturnType<typeof doing>;
const STATES: ["all" | Doing, string][] = [
  ["all", "All"],
  ["waiting", "Waiting"],
  ["working", "Working"],
  ["idle", "Idle"],
];

export function Overview() {
  const router = useRouter();
  const [starting, setStarting] = useState<{ repo?: string } | null>(null);
  /* Never remembered between visits. This is the screen somebody lands on to
     see everything, and a filter still applied from yesterday is a page lying
     about the fleet. */
  const [state, setState] = useState<"all" | Doing>("all");
  const [repo, setRepo] = useState<string | undefined>(undefined);
  /* Ticked workspaces, cleared whenever the filter moves — otherwise somebody
     ticks two, filters to a repository holding neither, and the button names a
     count they cannot see. */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [report, setReport] = useState<{ ended: number; unreachable: number } | null>(null);

  const { data: sessions = [], isPending } = useListSessions();

  const live = useMemo(() => sessions.filter((s) => s.status !== "Ended"), [sessions]);
  // Only for the headline: a banner under it saying the same number again is
  // the same fact twice.
  const waiting = live.filter(needsYou);

  // Repository → workspace → the runs in it, the same three levels the rail
  // draws beside it. One shape for both, because reading the fleet twice over
  // should not mean reading it two different ways.
  const repos = useMemo(() => group(live), [live]);

  /**
   * What the filters leave.
   *
   * A pass over what is loaded rather than a request, which is the one place
   * this screen deliberately parts company with Tasks. Tasks pages through
   * somebody else's data, so filtering there has to be a parameter or the page
   * comes back short; the whole live fleet is already here.
   */
  const filtering = state !== "all" || !!repo;
  const shown = useMemo(() => {
    const groups = repos.groups
      .filter(([name]) => !repo || name === repo)
      .map(
        ([name, places]) =>
          [name, places.filter((p) => state === "all" || doing(p) === state)] as [
            string,
            Workspace[],
          ],
      )
      .filter(([, places]) => places.length > 0);

    return { groups, total: groups.reduce((n, [, places]) => n + places.length, 0) };
  }, [repos, repo, state]);

  /** Every workspace on screen, and the ticked ones among them. */
  const onScreen = useMemo(
    () => shown.groups.flatMap(([, places]) => places),
    [shown],
  );
  // Intersected rather than trusted: a ticked workspace that ends somewhere
  // else disappears from the list, and its id must not stay in the count.
  const chosen = onScreen.filter((p) => picked.has(p.id));

  /** Changing what is on screen throws the ticks away. */
  const refilter = (change: () => void) => {
    change();
    setPicked(new Set());
    setReport(null);
  };

  const going = chosen.length > 0 ? chosen : onScreen;
  /** Nothing ticked and nothing filtered is the whole fleet, as it always was. */
  const everything = chosen.length === 0 && !filtering;

  const label =
    chosen.length > 0
      ? `End ${chosen.length} ${chosen.length === 1 ? "workspace" : "workspaces"}`
      : everything
        ? `End all ${repos.total} ${repos.total === 1 ? "workspace" : "workspaces"}`
        : state !== "all"
          ? `End ${onScreen.length} ${state}`
          : `End ${onScreen.length} ${onScreen.length === 1 ? "workspace" : "workspaces"}`;

  const nothing =
    state === "waiting"
      ? "Nothing is waiting on you."
      : state === "working"
        ? "Nothing is working."
        : state === "idle"
          ? "Nothing is idle."
          : "Nothing here.";

  return (
    <div className="px-8 pt-8 pb-24">
      <PageHead
        eyebrow="Sessions"
        title={
          isPending
            ? "Looking…"
            : waiting.length > 0
              ? `${waiting.length} waiting on you.`
              : repos.total === 0
                ? "Nothing running."
                : `${repos.total} ${repos.total === 1 ? "workspace" : "workspaces"}.`
        }
        aside={
          <Button variant="primary" icon={Plus} onClick={() => setStarting({})}>
            New workspace
          </Button>
        }
      >
        A worktree on one of your hosts, with any number of agents in it.
      </PageHead>

      {/* What the last press actually did. The server skips a workspace whose
          host is not answering, so "ended" and "asked for" are not always the
          same number, and the difference is the useful half. */}
      {report && (
        <p className="mb-3 text-meta text-mute">
          {report.ended} ended
          {report.unreachable > 0 &&
            ` · ${report.unreachable} left alone, their host isn't answering`}
        </p>
      )}

      {isPending && <p className="py-8 text-center text-ui text-mute">Looking…</p>}

      {/* Nothing at all is a different screen from nothing matching: there are
          no filters worth showing when there is no fleet to filter. */}
      {!isPending && live.length === 0 && (
        <Empty
          icon={Waypoints}
          action={
            <Button variant="primary" icon={Plus} onClick={() => setStarting({})}>
              New workspace
            </Button>
          }
        >
          Nothing running. Describe some work and it runs on your own hardware.
        </Empty>
      )}

      {!isPending && live.length > 0 && (
        <Card>
          <CardHead
            aside={
              <div className="flex items-center gap-3">
                <span className="font-mono text-meta text-mute">
                  {filtering
                    ? `${shown.total} of ${repos.total}`
                    : waiting.length > 0
                      ? `${repos.total} · ${waiting.length} waiting`
                      : repos.total}
                </span>
                {onScreen.length > 0 && (
                  <EndThese
                    label={label}
                    places={going}
                    everything={everything}
                    scope={
                      chosen.length > 0
                        ? "the ones you ticked"
                        : everything
                          ? "everything you have running"
                          : state !== "all"
                            ? `everything ${state}`
                            : `everything in ${repo}`
                    }
                    onEnded={(result) => {
                      setPicked(new Set());
                      setReport(result);
                    }}
                  />
                )}
              </div>
            }
          >
            <Segmented
              options={STATES}
              value={state}
              onChange={(v) => refilter(() => setState(v))}
            />

            {/* Only repositories that have something in them: a filter that can
                select an empty result is a filter that can lie about the
                fleet. */}
            <Select
              value={repo ?? ""}
              onChange={(v) => refilter(() => setRepo(v || undefined))}
              options={[
                ["", "All repositories"],
                ...repos.groups.map(([name]) => [name, name] as [string, string]),
              ]}
            />
          </CardHead>

          {shown.total === 0 ? (
            <div className="px-4 py-12 text-center">
              <p className="text-ui text-dim">{nothing}</p>
              <div className="mt-3">
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() =>
                    refilter(() => {
                      setState("all");
                      setRepo(undefined);
                    })
                  }
                >
                  Clear the filter to see all {repos.total}
                </Button>
              </div>
            </div>
          ) : (
            <>
              <Columns>
                {/* Ticks what is on screen, not the fleet: filter first, tick
                    all, end. Anything else is a button that ends work nobody
                    can see. */}
                <Tick
                  label="Select everything shown"
                  on={chosen.length === onScreen.length}
                  mixed={chosen.length > 0 && chosen.length < onScreen.length}
                  onToggle={() =>
                    setPicked(
                      chosen.length === onScreen.length
                        ? new Set()
                        : new Set(onScreen.map((p) => p.id)),
                    )
                  }
                />
                <span className={COL.lead} />
                <span className="min-w-0 flex-1">Workspace / branch</span>
                <span className={COL.agents}>Agents</span>
                <span className={`${COL.when} text-right`}>Started</span>
                <span className={`${COL.state} text-right`}>State</span>
              </Columns>

              <List flush>
                {shown.groups.map(([name, workspaces]) => (
                  <div key={name}>
                    {/* The repository, once, above the worktrees cut from it —
                        rather than its slug repeated down forty rows. Filtered
                        to one, it would be a heading over the only group there
                        is, so it goes. */}
                    {!repo && (
                      <div className="flex items-center gap-2 border-b border-line-soft bg-raise/40 px-4 py-1.5">
                        <GithubMark size={12} className="text-mute" />
                        <span className="min-w-0 truncate font-mono text-meta text-dim">
                          {name}
                        </span>
                        <span className="ml-auto font-mono text-micro text-mute">
                          {workspaces.length}
                        </span>
                      </div>
                    )}
                    <div className="divide-y divide-line-soft">
                      {workspaces.map((place) => (
                        <Place
                          key={place.id}
                          place={place}
                          ticked={picked.has(place.id)}
                          onTick={() =>
                            setPicked((held) => {
                              const next = new Set(held);
                              if (next.has(place.id)) next.delete(place.id);
                              else next.add(place.id);
                              return next;
                            })
                          }
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </List>
            </>
          )}
        </Card>
      )}

      {starting && (
        <Modal onClose={() => setStarting(null)} title="New workspace" wide>
          <NewWorkspace
            startWith={starting.repo}
            onCreated={(id) => {
              setStarting(null);
              router.push(`/sessions/${id}`);
            }}
          />
        </Modal>
      )}
    </div>
  );
}

/**
 * One tick.
 *
 * An ordinary controlled checkbox, and it has to stay ordinary: it sits beside
 * the row's link rather than inside it, because cancelling a click to stop the
 * navigation also cancels the box's own toggle.
 */
function Tick({
  on,
  mixed,
  onToggle,
  label,
}: {
  on: boolean;
  mixed?: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <input
      type="checkbox"
      checked={on}
      aria-label={label}
      title={label}
      ref={(el) => {
        if (el) el.indeterminate = !!mixed && !on;
      }}
      onChange={onToggle}
      className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-bone"
    />
  );
}

/** One workspace and the agents in it, as a row you can open. */
function Place({
  place,
  ticked,
  onTick,
}: {
  place: Workspace;
  ticked: boolean;
  onTick: () => void;
}) {
  const anyWaiting = place.runs.some(needsYou);
  const state = doing(place);

  return (
    <Row
      href={`/sessions/${place.id}`}
      className={ticked ? "bg-raise/60" : ""}
      lead={<Tick on={ticked} onToggle={onTick} label={`Select ${place.name}`} />}
    >
      <Signal status={place.runs[0].status} size={6} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-title text-bone">{place.name}</span>
          {anyWaiting && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ember" />}
        </div>
        <div className="truncate font-mono text-meta text-mute">{place.branch ?? "—"}</div>
      </div>

      {/* Which agents are in it, rather than how many: two of one and one of
          another is a different place from three of one, and a count says
          neither. */}
      <div className={`${COL.agents} flex items-center gap-2`}>
        {place.runs.slice(0, 4).map((run) => (
          <span key={run.id} className="flex items-center gap-1" title={AGENT_SHORT[run.agent]}>
            <AgentMark agent={run.agent} size={11} className="text-mute" />
          </span>
        ))}
        {place.runs.length > 4 && (
          <span className="font-mono text-micro text-mute">+{place.runs.length - 4}</span>
        )}
      </div>

      <span className={`${COL.when} text-right font-mono text-meta text-mute`}>
        {elapsed(minutesSince(place.runs[0].createdAt))}
      </span>

      <div className={`${COL.state} flex justify-end`}>
        <Badge tone={state === "waiting" ? "ember" : state === "working" ? "slate" : "neutral"}>
          {state}
        </Badge>
      </div>
    </Row>
  );
}

/**
 * The one destructive control, and the reason this page exists at all.
 *
 * Counted in workspaces, because that is what somebody loses: "48 ended" is a
 * number nobody recognises, and it was six places.
 *
 * It sits in the card header, under the filter that decides what it means — so
 * the label names the exact thing that goes, and the confirmation says it again
 * with the names attached while the list is short enough to read.
 */
function EndThese({
  label,
  places,
  everything,
  scope,
  onEnded,
}: {
  label: string;
  places: Workspace[];
  /** The whole fleet: send no list, which is what this endpoint always did. */
  everything: boolean;
  scope: string;
  onEnded: (result: { ended: number; unreachable: number }) => void;
}) {
  const [asking, setAsking] = useState(false);
  const cache = useQueryClient();
  const end = useEndAllSessions();

  const count = places.length;
  if (count === 0) return null;

  return (
    <>
      <Button variant="danger" size="sm" onClick={() => setAsking(true)}>
        {label}
      </Button>

      {asking && (
        <Modal onClose={() => setAsking(false)} title={label}>
          <p className="text-ui text-dim">
            {count === 1 ? "One workspace" : `${count} workspaces`} — {scope} — and every agent
            in them. Their worktrees go, and anything not pushed goes with them.
          </p>

          {/* The list itself while it is short enough to read. Past that a
              wall of names is not a check, it is scenery. */}
          {count <= 8 && (
            <ul className="mt-3 flex flex-col gap-1">
              {places.map((p) => (
                <li key={p.id} className="flex items-baseline gap-2 text-meta">
                  <span className="truncate text-text">{p.name}</span>
                  <span className="truncate font-mono text-mute">{p.branch ?? "—"}</span>
                </li>
              ))}
            </ul>
          )}

          <p className="mt-3 text-meta text-mute">
            Branches already pushed stay on the remote. A host that is not answering keeps its
            workspaces until it comes back.
          </p>

          <div className="mt-5 flex items-center justify-end gap-2">
            <Button variant="quiet" onClick={() => setAsking(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={end.isPending}
              onClick={() =>
                end.mutate(
                  { data: { workspaces: everything ? null : places.map((p) => p.id) } },
                  {
                    onSuccess: (result) => onEnded(result),
                    onSettled: () => {
                      setAsking(false);
                      cache.invalidateQueries({ queryKey: getListSessionsQueryKey() });
                    },
                  },
                )
              }
            >
              {end.isPending ? "Ending…" : label}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
