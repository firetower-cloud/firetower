/**
 * One server's fleet.
 *
 * Same columns as the web dashboard — workspace and branch together, which
 * agents, when it started, what it is doing — and the same filters, because
 * that is the vocabulary. What a window adds is density and a keyboard: rows
 * are 34px, and the whole table is one scroll region rather than a page.
 */
import { useMemo, useState } from "react";
import { CircleDashed, Plus } from "lucide-react";
import { Signal } from "@/components/Signal";
import { AgentMark } from "@/components/AgentMark";
import { GithubMark, Icon } from "@/components/ui";
import { doing, group, shortRepo, type Workspace } from "@/src/api/workspaces";
import { elapsed, minutesSince, needsYou } from "@/src/api/view";
import { STATE, type Backend } from "~/mock/backends";
import { useFixtures } from "~/mock/socket";
import { navigate } from "~/shims/next-navigation";
import { useStart } from "~/start";

type Filter = "all" | "waiting" | "working" | "idle";
const FILTERS: [Filter, string][] = [
  ["all", "All"],
  ["waiting", "Waiting"],
  ["working", "Working"],
  ["idle", "Idle"],
];

export function Dashboard({ backend }: { backend: Backend }) {
  useFixtures();
  const start = useStart();
  const [filter, setFilter] = useState<Filter>("all");
  const [repo, setRepo] = useState("all");

  const live = STATE[backend.id].filter((s) => s.status !== "Ended");
  const repos = useMemo(() => group(live), [live.map((s) => s.status + s.updatedAt).join()]);

  const shown = repos.groups
    .filter(([name]) => repo === "all" || name === repo)
    .map(([name, places]): [string, Workspace[]] => [
      name,
      places.filter((p) => filter === "all" || doing(p) === filter),
    ])
    .filter(([, places]) => places.length > 0);

  const waiting = live.filter(needsYou).length;
  const total = repos.total;

  return (
    <div className="scroll-slim h-full overflow-y-auto">
      <div className="mx-auto max-w-[1000px] px-6 py-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-display text-bone">
              {waiting > 0 ? `${waiting} waiting on you.` : `${total} running.`}
            </h1>
            <p className="mt-1 max-w-[440px] text-body text-dim">
              A branch on one of your hosts — a git worktree per repository — with any number of
              agents in it.
            </p>
          </div>
          <button
            onClick={() => start()}
            className="control border border-line bg-raise text-bone transition-colors hover:bg-overlay"
          >
            <Icon of={Plus} size={14} />
            New workspace
          </button>
        </div>

        <div className="mt-5 overflow-hidden rounded-lg border border-line bg-panel">
          <div className="flex items-center gap-2 border-b border-line px-2.5 py-2">
            <div className="track">
              {FILTERS.map(([f, label]) => (
                <button key={f} data-on={filter === f} onClick={() => setFilter(f)}>
                  {label}
                </button>
              ))}
            </div>

            <select
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              className="h-7 rounded-md border border-line bg-ground px-2 text-ui text-dim focus:outline-none"
            >
              <option value="all">All repositories</option>
              {repos.groups.map(([name]) => (
                <option key={name} value={name}>
                  {shortRepo(name)}
                </option>
              ))}
            </select>

            <span className="ml-auto text-meta text-mute">
              {total} · {waiting} waiting
            </span>
            {total > 0 && (
              <button className="rounded-md border border-brick-deep bg-brick-tint px-2.5 py-1 text-ui text-brick transition-colors hover:bg-brick-deep/40">
                End all {total}
              </button>
            )}
          </div>

          <div className="flex items-center gap-3 border-b border-line-soft px-3 py-1.5">
            <span className="w-[15px] shrink-0" />
            <span className="eyebrow flex-1">Workspace / branch</span>
            <span className="eyebrow w-[92px] shrink-0">Agents</span>
            <span className="eyebrow w-[64px] shrink-0">Started</span>
            <span className="eyebrow w-[84px] shrink-0">State</span>
          </div>

          {shown.length === 0 && (
            <p className="px-3 py-6 text-center text-ui text-mute">Nothing matches.</p>
          )}

          {shown.map(([name, places]) => (
            <div key={name}>
              <div className="flex items-center gap-1.5 bg-ground/40 px-3 py-1">
                {name === "no repository" ? (
                  <Icon of={CircleDashed} size={12} className="text-mute" />
                ) : (
                  <GithubMark size={11} className="text-mute" />
                )}
                <span className="font-mono text-micro text-dim">{name}</span>
                <span className="ml-auto font-mono text-micro text-mute">{places.length}</span>
              </div>
              {places.map((place) => (
                <Line key={place.id} place={place} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Line({ place }: { place: Workspace }) {
  const state = doing(place);
  const lead = place.runs[0];

  return (
    <button
      onClick={() => navigate(`/sessions/${place.id}`)}
      className="flex h-[var(--row)] w-full items-center gap-3 px-3 text-left transition-colors hover:bg-raise/60"
    >
      <span className="w-[15px] shrink-0">
        <Signal status={lead.status} size={5} />
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-ui text-bone">{place.name}</span>
          {place.runs.some(needsYou) && <span className="h-1.5 w-1.5 rounded-full bg-ember" />}
        </span>
        <span className="block truncate font-mono text-micro text-mute">{place.branch}</span>
      </span>

      <span className="flex w-[92px] shrink-0 items-center gap-1">
        {place.runs.slice(0, 4).map((run) => (
          <AgentMark key={run.id} agent={run.agent} size={11} className="text-mute" />
        ))}
      </span>

      <span className="w-[64px] shrink-0 font-mono text-micro text-mute">
        {elapsed(minutesSince(lead.createdAt))}
      </span>

      <span className="w-[84px] shrink-0">
        <span
          className={`rounded-sm border px-1.5 py-0.5 text-micro ${
            state === "waiting"
              ? "border-ember-deep bg-ember-tint text-ember-soft"
              : state === "working"
                ? "border-slate-deep bg-slate-tint text-slate"
                : "border-line bg-raise text-mute"
          }`}
        >
          {state === "waiting" ? "your move" : state}
        </span>
      </span>
    </button>
  );
}
