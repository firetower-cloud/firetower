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
import { useListTasks } from "@/src/api/generated/tasks/tasks";
import { useListRepos } from "@/src/api/generated/repos/repos";
import type { Task, TaskKind, TaskState } from "@/src/api/generated/model";
import { Modal } from "@/components/Modal";
import { TaskDialog } from "@/components/TaskDialog";
import { NewWorkspace } from "@/components/NewWorkspace";
import { elapsed, minutesSince } from "@/src/api/view";

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
      <header className="mb-5 max-w-[900px]">
        <div className="eyebrow">Tasks</div>
        <h1 className="mt-2 text-[26px] font-semibold tracking-[-0.02em] text-bone">
          {isPending ? "Looking…" : `${data?.total ?? tasks.length} to pick from.`}
        </h1>
        <p className="mt-1.5 max-w-[56ch] text-[14px] text-dim">
          Read from GitHub as you look, never copied here. Starting one cuts a worktree and puts
          the issue in the composer — unsent, so you can say what you want done with it first.
        </p>
      </header>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Toggle
          options={[
            ["issue", "Issues"],
            ["pullRequest", "PRs"],
          ]}
          value={kind}
          onChange={change<TaskKind>(setKind)}
        />

        <Toggle
          options={[
            ["open", "Open"],
            ["closed", "Closed"],
          ]}
          value={state}
          onChange={change<TaskState>(setState)}
        />

        <button
          onClick={() => change<boolean>(setMine)(!mine)}
          className={`rounded-[8px] border px-3 py-1.5 text-ui transition-colors ${
            mine
              ? "border-ember-deep bg-ember/[0.08] text-ember"
              : "border-line text-mute hover:text-text"
          }`}
        >
          Assigned to me
        </button>

        <select
          // Chrome restores form controls across a reload and fires change as
          // it does, which quietly narrowed the page to whichever repository
          // had been chosen in a previous life — with the heading and the query
          // line honestly reporting a scope nobody had picked this time.
          autoComplete="off"
          value={repo ?? ""}
          onChange={(e) => change<string | undefined>(setRepo)(e.target.value || undefined)}
          className="rounded-[8px] border border-line bg-ground px-2.5 py-1.5 text-ui text-dim focus:border-ember focus:outline-none"
        >
          <option value="">All your repositories</option>
          {repos.map((r) => (
            <option key={r.id} value={r.slug}>
              {r.slug}
            </option>
          ))}
        </select>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            change<string>(setQ)(typed);
          }}
          className="flex min-w-[240px] flex-1 items-center gap-2"
        >
          <input
            value={typed}
            autoComplete="off"
            onChange={(e) => setTyped(e.target.value)}
            placeholder="label:bug sort:updated-desc"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-[8px] border border-line bg-ground px-3 py-1.5 font-mono text-[12.5px] text-bone placeholder:text-mute focus:border-ember focus:outline-none"
          />
        </form>

        <button
          onClick={() => refetch()}
          title="Ask again"
          className="rounded-[8px] border border-line px-2.5 py-1.5 text-ui text-mute transition-colors hover:text-ember"
        >
          {isFetching ? "…" : "↻"}
        </button>
      </div>

      {/* What the chips actually sent. Shown because the box only holds what
          somebody typed, and the request is both — seeing it is how you learn
          the syntax well enough to type past the chips. */}
      <p className="mb-4 font-mono text-[11px] text-mute">
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

      {isError && (
        <div className="rounded-[10px] border border-ember-deep bg-ember/[0.05] px-4 py-3">
          <p className="text-[13.5px] text-ember">{message(error)}</p>
        </div>
      )}

      {!isError && isPending && <p className="py-10 text-center text-[13px] text-mute">Looking…</p>}

      {!isError && !isPending && tasks.length === 0 && (
        <div className="rounded-[10px] border border-dashed border-line px-5 py-10 text-center">
          <p className="text-[14px] text-dim">Nothing matches.</p>
          <p className="mx-auto mt-1.5 max-w-[46ch] text-[12.5px] leading-[1.6] text-mute">
            The filters above are sent to GitHub as a query, so anything its own search accepts
            works in the box.
          </p>
        </div>
      )}

      {tasks.length > 0 && (
        <div className="overflow-hidden rounded-[10px] border border-line">
          {tasks.map((task, i) => (
            <Row
              key={task.id}
              task={task}
              first={i === 0}
              onRead={() => setReading(i)}
              onStart={() => setStarting(task)}
            />
          ))}
        </div>
      )}

      {(page > 1 || data?.more) && (
        <div className="mt-4 flex items-center justify-center gap-4">
          <button
            disabled={page <= 1}
            onClick={() => setPage((n) => n - 1)}
            className="text-ui text-mute transition-colors hover:text-text disabled:opacity-40"
          >
            ‹ Previous
          </button>
          <span className="font-mono text-[12px] text-dim">{page}</span>
          <button
            disabled={!data?.more}
            onClick={() => setPage((n) => n + 1)}
            className="text-ui text-mute transition-colors hover:text-text disabled:opacity-40"
          >
            Next ›
          </button>
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
function Row({
  task,
  first,
  onRead,
  onStart,
}: {
  task: Task;
  first: boolean;
  onRead: () => void;
  onStart: () => void;
}) {
  return (
    <div
      className={`flex items-center gap-4 px-4 py-3 transition-colors hover:bg-raise/40 ${
        first ? "" : "border-t border-line"
      }`}
    >
      <a
        href={task.url}
        target="_blank"
        rel="noreferrer"
        title="Read it on GitHub"
        className="w-16 shrink-0 rounded-[6px] border border-line px-2 py-1 text-center font-mono text-[11px] text-mute transition-colors hover:text-ember"
      >
        {task.key}
      </a>

      <div className="min-w-0 flex-1">
        <button onClick={onRead} className="block w-full truncate text-left">
          <span className="text-[14px] text-text">{task.title}</span>
        </button>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {task.assignees.slice(0, 3).map((who) => (
            <span key={who.login} className="font-mono text-[11px] text-mute">
              {who.login}
            </span>
          ))}
          {task.labels.slice(0, 4).map((label) => (
            <span
              key={label.name}
              className="rounded-[5px] border px-1.5 py-px text-[10.5px]"
              style={
                label.colour
                  ? { borderColor: `#${label.colour}66`, color: `#${label.colour}` }
                  : undefined
              }
            >
              {label.name}
            </span>
          ))}
        </div>
      </div>

      <span
        className={`shrink-0 rounded-[6px] border px-2 py-0.5 text-[11px] ${
          task.state === "open"
            ? "border-sage/40 text-sage"
            : "border-line text-mute"
        }`}
      >
        {task.state === "open" ? "Open" : "Closed"}
      </span>

      <span className="w-16 shrink-0 text-right font-mono text-[11px] text-mute">
        {elapsed(minutesSince(task.updatedAt))}
      </span>

      {/* Reading is the safe one and comes first; starting is the deliberate
          one and is the last thing on the row. Both are named, because an icon
          alone is a guess on first sight. */}
      <button
        onClick={onRead}
        title="Read it"
        className="shrink-0 rounded-[8px] border border-line px-3 py-1.5 text-ui text-mute transition-colors hover:text-text"
      >
        View
      </button>

      <button
        onClick={onStart}
        className="shrink-0 rounded-[8px] border border-line px-3 py-1.5 text-ui text-dim transition-colors hover:border-ember/40 hover:text-ember"
      >
        Start →
      </button>
    </div>
  );
}

function Toggle<T extends string>({
  options,
  value,
  onChange,
}: {
  options: [T, string][];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex items-center gap-px rounded-[8px] border border-line p-px">
      {options.map(([id, label]) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          className={`rounded-[7px] px-3 py-1.5 text-ui transition-colors ${
            id === value ? "bg-raise text-bone" : "text-mute hover:text-text"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** The reason it failed, which is usually "not connected yet". */
function message(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return "Could not reach GitHub.";
}
