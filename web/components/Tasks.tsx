"use client";

/**
 * What you could work on, from wherever you track it.
 *
 * Nothing here is stored. The list is read from the tracker on view, because
 * issues are somebody else's source of truth and keeping a copy means a webhook
 * receiver, a reconciliation job and rules for whose copy wins. What this screen
 * needs is "show me what is open and let me start one", which is a request.
 *
 * ## The chips and the box are one string
 *
 * Every filter is a parameter on that request, never a pass over what came
 * back — filtering thirty rows here would hide some, leave a short page and
 * make the next one nonsense. Clicking a chip writes into the query; typing in
 * the query does what a chip would have. That is why they sit next to each
 * other and why a second tracker can keep the controls and change dialect.
 */

import { useState } from "react";
import { ArrowRight, RotateCw, UserRound } from "lucide-react";
import { useListTasks } from "@/src/api/generated/tasks/tasks";
import {
  useListTrackerScopes,
  useListTrackers,
} from "@/src/api/generated/trackers/trackers";
import type { Task, TaskKind, TaskState, TrackerStatus } from "@/src/api/generated/model";
import {
  START,
  back,
  cursorAt,
  describeQuery,
  everything,
  forward,
  queryHint,
} from "@/src/api/tasks";
import { TaskDialog } from "@/components/TaskDialog";
import { NewWorkspaceModal } from "@/components/NewWorkspace";
import { ConnectTracker } from "@/components/ConnectTracker";
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardHead,
  Columns,
  Input,
  List,
  PageHead,
  Row,
  Segmented,
  Select,
} from "@/components/ui";
import { elapsed, minutesSince } from "@/src/api/view";

/** One set of widths, shared by the legend and every row under it. */
/**
 * The columns, and which of them a phone has room for.
 *
 * These add up to 464px of fixed width, which is wider than a phone. The title
 * beside them is `flex-1 min-w-0`, and what `min-w-0` means when the row
 * overflows is *zero*: the one thing somebody reads a task list for collapsed
 * to nothing, and the buttons at the end of the row sat off the side of the
 * screen. So everything that is context rather than the task itself is dropped
 * below `md`, and the title gets the room back.
 */
const COL = {
  id: "w-[72px] shrink-0",
  who: "hidden md:flex w-[88px] shrink-0",
  state: "hidden md:block w-[76px] shrink-0",
  when: "hidden md:block w-[76px] shrink-0",
  act: "shrink-0 md:w-[152px]",
};

export function Tasks() {
  const { data: trackers = [] } = useListTrackers();
  const [source, setSource] = useState("github");

  const tracker = trackers.find((t) => t.id === source);
  /** Nothing to ask for until there is a credential to ask with. */
  const ready = tracker?.connected !== false;
  const scopeKind = tracker?.scopeKind ?? "repos";
  /** What this tracker can return. A single kind is not a choice to offer. */
  const kinds = tracker?.kinds ?? ["issue", "pullRequest"];

  const { data: scopes = [] } = useListTrackerScopes(source, {
    // Asking a tracker nobody has connected answers 409 and nothing else.
    query: { enabled: !!tracker?.connected, staleTime: 300_000 },
  });

  const [kind, setKind] = useState<TaskKind>("issue");
  const [state, setState] = useState<TaskState>("open");
  const [mine, setMine] = useState(false);
  const [scope, setScope] = useState<string | undefined>(undefined);
  const [q, setQ] = useState("");
  const [typed, setTyped] = useState("");
  const [page, setPage] = useState(1);
  const [trail, setTrail] = useState(START);
  const [starting, setStarting] = useState<Task | null>(null);
  const [connecting, setConnecting] = useState<TrackerStatus | null>(null);
  /** Which row is open for reading, by position in the page. */
  const [reading, setReading] = useState<number | null>(null);

  // A scope belongs to one tracker — `acme/web` means nothing to Linear — and
  // so does the kind, so both are dropped rather than carried across. Done
  // where the change happens rather than in an effect reacting to it, which
  // would render one frame asking the new tracker for the old tracker's repo.
  const pickSource = (next: string) => {
    setSource(next);
    setScope(undefined);
    setKind(trackers.find((t) => t.id === next)?.kinds[0] ?? "issue");
    setPage(1);
    setTrail(START);
    setReading(null);
  };

  const params = {
    source,
    kind,
    state,
    mine,
    ...(scopeKind === "teams" ? { team: scope } : { repo: scope }),
    q: q || undefined,
    page,
    cursor: cursorAt(trail),
  };

  const { data, isPending, isError, error, refetch, isFetching } = useListTasks(params, {
    // Long enough that paging back and forth is instant, short enough that
    // somebody who just filed an issue and pressed refresh gets it.
    query: { staleTime: 60_000, enabled: ready },
  });

  const tasks = data?.tasks ?? [];
  /** Page numbers or cursors, whichever this tracker answered with. */
  const showing = trail.at > 0 ? trail.at + 1 : page;

  /** Any change to what is being asked for starts again at the first page. */
  const change = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setPage(1);
    setTrail(START);
  };


  return (
    <div className="px-4 pt-5 pb-24 md:px-8 md:pt-6">
      <PageHead
        eyebrow="Tasks"
        title={
          isPending
            ? "Looking…"
            : // Linear's connection carries no total, so counting what came
              // back is the honest answer rather than a number that reads as
              // "all of them".
              data?.total != null
              ? `${data.total} to pick from.`
              : `${tasks.length} on this page.`
        }
      >
        Read from {tracker?.label ?? "the tracker"} as you look. Starting one opens a workspace.
      </PageHead>

      {/* One card: what you are asking for, and what came back. The filters
          were a loose row floating above a bordered list, which read as two
          unrelated things — and the query line between them belongs to the
          controls, not to the results. */}
      <Card>
        <CardHead
          note={
            /* What the chips actually sent, in the dialect of whatever they
               were sent to. Shown because the box only holds what somebody
               typed, and the request is both — seeing it is how you learn the
               syntax well enough to type past the chips. */
            <p className="font-mono text-meta text-mute">
              {describeQuery(source, { scope, kind, state, mine, q })}
            </p>
          }
        >
          {trackers.length > 1 && (
            <Segmented
              options={trackers.map((t) => [t.id, t.label] as [string, string])}
              value={source}
              onChange={pickSource}
            />
          )}

          {/* A tracker with one kind of thing in it has nothing to toggle, and
              a two-way control with one option is a control that lies. */}
          {kinds.length > 1 && (
            <Segmented
              options={kinds.map(
                (k) => [k, k === "pullRequest" ? "PRs" : "Issues"] as [TaskKind, string],
              )}
              value={kind}
              onChange={change<TaskKind>(setKind)}
            />
          )}

          <Segmented
            options={[
              ["open", "Open"],
              ["closed", "Closed"],
            ]}
            value={state}
            onChange={change<TaskState>(setState)}
          />

          <Button
            icon={UserRound}
            variant={mine ? "primary" : "default"}
            onClick={() => change<boolean>(setMine)(!mine)}
          >
            Assigned to me
          </Button>

          <Select
            value={scope ?? ""}
            onChange={(v) => change<string | undefined>(setScope)(v || undefined)}
            options={[
              ["", everything(scopeKind)],
              ...scopes.map((s) => [s.key, s.label] as [string, string]),
            ]}
          />

          <form
            onSubmit={(e) => {
              e.preventDefault();
              change<string>(setQ)(typed);
            }}
            className="flex min-w-[220px] flex-1 items-center gap-2"
          >
            <Input
              value={typed}
              onChange={setTyped}
              mono
              placeholder={queryHint(source)}
              className="flex-1"
            />
          </form>

          <Button
            icon={RotateCw}
            title="Ask again"
            onClick={() => refetch()}
            disabled={isFetching}
          />
        </CardHead>

        {/* Not an error, and not an empty list: there is simply nothing to ask
            with yet, and the thing to do about it is one button. */}
        {!ready && tracker && (
          <div className="px-4 py-12 text-center">
            <p className="text-ui text-dim">{tracker.label} isn&rsquo;t connected yet.</p>
            <p className="mx-auto mt-1 max-w-[42ch] text-meta text-mute">
              It connects with a personal API key rather than a sign-in, and reading your tasks
              needs one.
            </p>
            <div className="mt-4 flex justify-center">
              <Button onClick={() => setConnecting(tracker)}>Connect {tracker.label}</Button>
            </div>
          </div>
        )}

        {ready && isError && (
          <p className="px-4 py-6 text-center text-ui text-brick">{message(error)}</p>
        )}

        {ready && !isError && isPending && (
          <p className="px-4 py-10 text-center text-ui text-mute">Looking…</p>
        )}

        {ready && !isError && !isPending && tasks.length === 0 && (
          <div className="px-4 py-12 text-center">
            <p className="text-ui text-dim">Nothing matches.</p>
            <p className="mt-1 text-meta text-mute">
              {source === "linear"
                ? "The box takes team, state, label, assignee, project and priority."
                : "The box takes anything GitHub search accepts."}
            </p>
          </div>
        )}

        {ready && tasks.length > 0 && (
          <>
            <Columns>
              <span className={COL.id}>ID</span>
              <span className="min-w-0 flex-1">Title / context</span>
              <span className={`${COL.who} truncate`}>Assignees</span>
              <span className={`${COL.state} truncate`}>Status</span>
              <span className={`${COL.when} text-right`}>Updated</span>
              <span className={COL.act} />
            </Columns>
            <List flush>
              {tasks.map((task, i) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  sourceLabel={tracker?.label ?? "the tracker"}
                  onRead={() => setReading(i)}
                  onStart={() => setStarting(task)}
                />
              ))}
            </List>
          </>
        )}
      </Card>

      {(showing > 1 || data?.more) && (
        <div className="mt-4 flex items-center justify-center gap-3">
          <Button
            variant="quiet"
            size="sm"
            disabled={showing <= 1}
            onClick={() => (trail.at > 0 ? setTrail(back(trail)) : setPage((n) => n - 1))}
          >
            ‹ Previous
          </Button>
          <span className="font-mono text-meta text-dim">{showing}</span>
          <Button
            variant="quiet"
            size="sm"
            disabled={!data?.more}
            onClick={() =>
              // A cursor when the tracker gave one, a page number otherwise.
              data?.next ? setTrail(forward(trail, data.next)) : setPage((n) => n + 1)
            }
          >
            Next ›
          </Button>
        </div>
      )}

      {reading !== null && tasks[reading] && (
        <TaskDialog
          task={tasks[reading]}
          sourceLabel={tracker?.label ?? "the tracker"}
          at={reading + 1}
          of={tasks.length}
          onMove={(by) =>
            setReading((at) =>
              at === null ? at : Math.min(tasks.length - 1, Math.max(0, at + by)),
            )
          }
          onClose={() => setReading(null)}
          onStart={() => {
            // Read, then decide. Closing this one and opening the other keeps
            // one dialog on screen at a time, and the workspace form is the same
            // one the `+` in the rail opens rather than a second copy of it.
            setStarting(tasks[reading]);
            setReading(null);
          }}
        />
      )}

      {connecting && (
        <ConnectTracker tracker={connecting} onClose={() => setConnecting(null)} />
      )}

      {starting && (
        <NewWorkspaceModal
          startWith={starting.repo ?? undefined}
          fromTask={{
            key: starting.key,
            title: starting.title,
            url: starting.url,
            body: starting.body ?? undefined,
          }}
          onClose={() => setStarting(null)}
        />
      )}
    </div>
  );
}

/** One task, and the button that turns it into a workspace. */
function TaskRow({
  task,
  sourceLabel,
  onRead,
  onStart,
}: {
  task: Task;
  sourceLabel: string;
  onRead: () => void;
  onStart: () => void;
}) {
  return (
    <Row>
      <a
        href={task.url}
        target="_blank"
        rel="noreferrer"
        title={`Read it on ${sourceLabel}`}
        onClick={(e) => e.stopPropagation()}
        className={`${COL.id} rounded-sm border border-line bg-ground px-2 py-1 text-center font-mono text-meta text-mute transition-colors hover:border-line hover:text-bone`}
      >
        {task.key}
      </a>

      <div className="min-w-0 flex-1 py-2.5">
        <button onClick={onRead} className="block w-full truncate text-left">
          <span className="text-title text-bone">{task.title}</span>
        </button>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {task.assignees.slice(0, 1).map((who) => (
            <span key={who.login} className="font-mono text-meta text-mute">
              {who.login}
            </span>
          ))}
          {task.labels.slice(0, 4).map((label) => (
            <Badge
              key={label.name}
              style={
                label.colour
                  ? {
                      // The tracker owns these colours. Its own hex at a tenth
                      // opacity behind, full strength on top: a label reads as
                      // itself without any one of them shouting over the row.
                      backgroundColor: `#${label.colour}1a`,
                      borderColor: `#${label.colour}44`,
                      color: `#${label.colour}`,
                    }
                  : undefined
              }
            >
              {label.name}
            </Badge>
          ))}
        </div>
      </div>

      <div className={`${COL.who} -space-x-1.5`}>
        {task.assignees.slice(0, 3).map((who) => (
          <Avatar key={who.login} name={who.login} />
        ))}
      </div>

      <div className={COL.state}>
        <Badge tone={task.state === "open" ? "sage" : "neutral"}>
          {task.state === "open" ? "Open" : "Closed"}
        </Badge>
      </div>

      <span className={`${COL.when} text-right font-mono text-meta text-mute`}>
        {elapsed(minutesSince(task.updatedAt))}
      </span>

      {/* Reading is the safe one and comes first; starting is the deliberate
          one and is the last thing on the row. Both are named, because an icon
          alone is a guess on first sight. */}
      <div className={`${COL.act} flex items-center justify-end gap-2`}>
        {/* Revealed on hover on a desk, where a row full of buttons is noise
            until you are pointing at it. A phone has no hover, so there it is
            simply there — it used to sit at `opacity-0` for ever, which is a
            control you can tap only by knowing where it is. */}
        <Button
          variant="quiet"
          size="sm"
          onClick={onRead}
          title="Read it"
          className="md:opacity-0 md:transition-opacity md:group-hover:opacity-100"
        >
          View
        </Button>
        <Button size="sm" trailing={ArrowRight} onClick={onStart}>
          Start
        </Button>
      </div>
    </Row>
  );
}

/** The reason it failed, which is usually "not connected yet". */
function message(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return "Could not reach the tracker.";
}
