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
import { Signal } from "~/components/Signal";
import { AgentMark } from "~/components/AgentMark";
import { GithubMark, Icon } from "~/components/ui";
import { doing, group, shortRepo, type Workspace } from "~/api/workspaces";
import { elapsed, minutesSince, needsYou } from "~/api/view";
import { useNow } from "~/ui/clock";
import type { Backend } from "~/fleet";
import { useSessions } from "~/data";
import { navigate } from "~/shims/next-navigation";
import { useStart } from "~/start";
import { useQueryClient } from "@tanstack/react-query";
import { endAllSessions, getListSessionsQueryKey } from "~/api/generated/sessions/sessions";
import { useConfirm } from "~/ui/Confirm";
import { why } from "~/data";

type Filter = "all" | "waiting" | "working" | "idle";
const FILTERS: [Filter, string][] = [
  ["all", "All"],
  ["waiting", "Waiting"],
  ["working", "Working"],
  ["idle", "Idle"],
];

export function Dashboard({ backend }: { backend: Backend }) {
  const start = useStart();
  const { data: sessions, loading, error } = useSessions();
  // Same reason as the rail's: the card ages come off the clock, and a session
  // working quietly produces no renders of its own.
  useNow();
  const [filter, setFilter] = useState<Filter>("all");
  const [repo, setRepo] = useState("all");

  const live = sessions.filter((s) => s.status !== "Ended");
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

  /* Ending what is on screen: every workspace the filters leave, and every
     agent in them — the web's rule, with its wording. Their worktrees go;
     branches already pushed stay on the remote. */
  const confirm = useConfirm();
  const cache = useQueryClient();
  const [ending, setEnding] = useState(false);
  const listed = shown.flatMap(([, places]) => places);
  const everything = repo === "all" && filter === "all";
  const endAll = async () => {
    const agents = listed.reduce((n, p) => n + p.runs.length, 0);
    const scope = everything ? "everything on this server" : repo !== "all" ? `in ${shortRepo(repo)}${filter !== "all" ? `, ${filter}` : ""}` : filter;
    const ok = await confirm({
      title: listed.length === 1 ? `End "${listed[0].name}"?` : `End all ${listed.length} workspaces?`,
      body: (
        <>
          <p>
            {listed.length === 1 ? "One workspace" : `${listed.length} workspaces`} — {scope} — and {agents === 1 ? "the agent" : `the ${agents} agents`} in them. Their worktrees go, and anything not pushed goes with them.
          </p>
          {listed.length <= 8 && (
            <ul className="mt-2.5 space-y-0.5">
              {listed.map((p) => (
                <li key={p.id} className="flex items-baseline gap-2 text-meta">
                  <span className="truncate text-text">{p.name}</span>
                  <span className="truncate font-mono text-mute">{p.branch ?? "—"}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2.5 text-meta text-mute">Branches already pushed stay on the remote. A machine that is not answering keeps its workspaces until it comes back.</p>
        </>
      ),
      action: listed.length === 1 ? "End workspace" : `End all ${listed.length}`,
      tone: "danger",
    });
    if (!ok) return;
    setEnding(true);
    try {
      const result = await endAllSessions({ workspaces: everything ? null : listed.map((p) => p.id) });
      await cache.invalidateQueries({ queryKey: getListSessionsQueryKey() });
      if (result.unreachable > 0) {
        await confirm({ title: `${result.ended} ended.`, body: `${result.unreachable} could not be reached and keep their workspaces until the machine answers.`, action: "OK" });
      }
    } catch (e) {
      await confirm({ title: "That did not work.", body: why(e), action: "OK" });
    } finally {
      setEnding(false);
    }
  };

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
            {listed.length > 0 && (
              <button disabled={ending} onClick={() => void endAll()} className="rounded-md border border-brick-deep bg-brick-tint px-2.5 py-1 text-ui text-brick transition-colors hover:bg-brick-deep/40 disabled:opacity-50">
                {ending ? "Ending…" : `End all ${listed.length}`}
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

          {loading && <p className="px-3 py-6 text-center text-ui text-mute">Loading…</p>}
          {error && <p className="px-3 py-6 text-center text-ui text-brick">{error}</p>}
          {!loading && !error && shown.length === 0 && (
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
