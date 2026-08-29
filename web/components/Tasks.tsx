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

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ArrowRight, RotateCw, UserRound } from "lucide-react";
import { useListTasks } from "@/src/api/generated/tasks/tasks";
import { useListRepos } from "@/src/api/generated/repos/repos";
import type { Task, TaskKind, TaskState } from "@/src/api/generated/model";
import { Modal } from "@/components/Modal";
import { TaskDialog } from "@/components/TaskDialog";
import { NewWorkspace } from "@/components/NewWorkspace";
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
const COL = {
  id: "w-[72px] shrink-0",
  who: "w-[88px] shrink-0",
  state: "w-[76px] shrink-0",
  when: "w-[76px] shrink-0",
  act: "w-[152px] shrink-0",
};

export function Tasks() {
  const router = useRouter();
  const { data: repos = [] } = useListRepos();

  const [kind, setKind] = useState<TaskKind>("issue");
  const [state, setState] = useState<TaskState>("open");
  const [mine, setMine] = useState(false);
  const [repo, setRepo] = useState<string | undefined>(undefined);
  const [q, setQ] = useState("");
  const [typed, setTyped] = useState("");
  const [page, setPage] = useState(1);
  const [starting, setStarting] = useState<Task | null>(null);
  /** Which row is open for reading, by position in the page. */
  const [reading, setReading] = useState<number | null>(null);

  const params = useMemo(
    () => ({ kind, state, mine, repo, q: q || undefined, page }),
    [kind, state, mine, repo, q, page],
  );

  const { data, isPending, isError, error, refetch, isFetching } = useListTasks(params, {
    // Long enough that paging back and forth is instant, short enough that
    // somebody who just filed an issue and pressed refresh gets it.
    query: { staleTime: 60_000 },
  });

  const tasks = data?.tasks ?? [];

  /** Any change to what is being asked for starts again at page one. */
  const change = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setPage(1);
  };

  return (
    <div className="px-8 pt-6 pb-24">
      <PageHead eyebrow="Tasks" title={isPending ? "Looking…" : `${data?.total ?? tasks.length} to pick from.`}>
        Read from GitHub as you look. Starting one cuts a worktree.
      </PageHead>

      {/* One card: what you are asking for, and what came back. The filters
          were a loose row floating above a bordered list, which read as two
          unrelated things — and the query line between them belongs to the
          controls, not to the results. */}
      <Card>
        <CardHead
          note={
            /* What the chips actually sent. Shown because the box only holds
               what somebody typed, and the request is both — seeing it is how
               you learn the syntax well enough to type past the chips. */
            <p className="font-mono text-meta text-mute">
              {[
                repo ? `repo:${repo}` : "your repositories",
                kind === "pullRequest" ? "is:pr" : "is:issue",
                state === "closed" ? "is:closed" : "is:open",
                mine && "assignee:@me",
                q,
              ]
                .filter(Boolean)
                .join(" ")}
            </p>
          }
        >
          <Segmented
            options={[
              ["issue", "Issues"],
              ["pullRequest", "PRs"],
            ]}
            value={kind}
            onChange={change<TaskKind>(setKind)}
          />

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
            value={repo ?? ""}
            onChange={(v) => change<string | undefined>(setRepo)(v || undefined)}
            options={[
              ["", "All your repositories"],
              ...repos.map((r) => [r.slug, r.slug] as [string, string]),
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
              placeholder="label:bug sort:updated-desc"
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

        {isError && <p className="px-4 py-6 text-center text-ui text-brick">{message(error)}</p>}

        {!isError && isPending && (
          <p className="px-4 py-10 text-center text-ui text-mute">Looking…</p>
        )}

        {!isError && !isPending && tasks.length === 0 && (
          <div className="px-4 py-12 text-center">
            <p className="text-ui text-dim">Nothing matches.</p>
            <p className="mt-1 text-meta text-mute">
              The box takes anything GitHub search accepts.
            </p>
          </div>
        )}

        {tasks.length > 0 && (
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
                  onRead={() => setReading(i)}
                  onStart={() => setStarting(task)}
                />
              ))}
            </List>
          </>
        )}
      </Card>

      {(page > 1 || data?.more) && (
        <div className="mt-4 flex items-center justify-center gap-3">
          <Button variant="quiet" size="sm" disabled={page <= 1} onClick={() => setPage((n) => n - 1)}>
            ‹ Previous
          </Button>
          <span className="font-mono text-meta text-dim">{page}</span>
          <Button variant="quiet" size="sm" disabled={!data?.more} onClick={() => setPage((n) => n + 1)}>
            Next ›
          </Button>
        </div>
      )}

      {reading !== null && tasks[reading] && (
        <TaskDialog
          task={tasks[reading]}
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
            // one dialog on screen at a time, and the worktree form is the same
            // one the `+` in the rail opens rather than a second copy of it.
            setStarting(tasks[reading]);
            setReading(null);
          }}
        />
      )}

      {starting && (
        <Modal onClose={() => setStarting(null)} title="New worktree" wide>
          <NewWorkspace
            startWith={starting.repo ?? undefined}
            fromTask={{
              key: starting.key,
              title: starting.title,
              url: starting.url,
              body: starting.body ?? undefined,
            }}
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

/** One task, and the button that turns it into a worktree. */
function TaskRow({
  task,
  onRead,
  onStart,
}: {
  task: Task;
  onRead: () => void;
  onStart: () => void;
}) {
  return (
    <Row>
      <a
        href={task.url}
        target="_blank"
        rel="noreferrer"
        title="Read it on GitHub"
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

      <div className={`${COL.who} flex -space-x-1.5`}>
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
        <Button
          variant="quiet"
          size="sm"
          onClick={onRead}
          title="Read it"
          className="opacity-0 transition-opacity group-hover:opacity-100"
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
  return "Could not reach GitHub.";
}
