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

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListSessionsQueryKey,
  useEndAllSessions,
  useListSessions,
} from "@/src/api/generated/sessions/sessions";
import type { Session } from "@/src/api/generated/model";
import { AgentMark, AGENT_SHORT } from "@/components/AgentMark";
import { Modal } from "@/components/Modal";
import { NewWorkspace } from "@/components/NewWorkspace";
import { Signal } from "@/components/Signal";
import { elapsed, inFlight, minutesSince, needsYou } from "@/src/api/view";

export function Overview() {
  const router = useRouter();
  const [starting, setStarting] = useState<{ repo?: string } | null>(null);
  const { data: sessions = [], isPending } = useListSessions();

  const live = useMemo(() => sessions.filter((s) => s.status !== "Ended"), [sessions]);
  // Only for the headline: a banner under it saying the same number again is
  // the same fact twice.
  const waiting = live.filter(needsYou);

  // Repository → workspace → the runs in it, the same three levels the rail
  // draws beside it. One shape for both, because reading the fleet twice over
  // should not mean reading it two different ways.
  const repos = useMemo(() => group(live), [live]);

  return (
    <div className="max-w-[900px] px-8 pt-8 pb-24">
      <header className="mb-7">
        <div className="eyebrow">Sessions</div>
        <div className="mt-2 flex items-baseline gap-3">
          <h1 className="text-[26px] font-semibold tracking-[-0.02em] text-bone">
            {isPending
              ? "Looking…"
              : waiting.length > 0
                ? `${waiting.length} waiting on you.`
                : repos.total === 0
                  ? "Nothing running."
                  : `${repos.total} ${repos.total === 1 ? "workspace" : "workspaces"}.`}
          </h1>
          <div className="ml-auto flex items-center gap-3">
            <EndEverything workspaces={repos.total} />
            <button
              onClick={() => setStarting({})}
              className="rounded-[8px] border border-dashed border-line px-3 py-1.5 text-ui text-mute transition-colors hover:border-ember/40 hover:text-ember"
            >
              + New workspace
            </button>
          </div>
        </div>
        <p className="mt-1.5 max-w-[56ch] text-[14px] text-dim">
          A workspace is a worktree on one of your hosts, with any number of agents working in
          it. Open one to read what they are doing.
        </p>
      </header>


          {isPending && <p className="py-8 text-center text-[13px] text-mute">Looking…</p>}

          {!isPending && live.length === 0 && (
            <div className="rounded-[10px] border border-dashed border-line px-5 py-10 text-center">
              <p className="text-[14px] text-dim">Nothing running.</p>
              <p className="mx-auto mt-1.5 max-w-[46ch] text-[12.5px] leading-[1.6] text-mute">
                Describe some work and it runs on your own hardware — you can close the laptop as
                soon as it starts.
              </p>
            </div>
          )}

          {repos.groups.map(([repo, workspaces]) => (
            <section key={repo} className="mb-6">
              <div className="mb-1.5 flex items-center gap-2 px-1">
                <span className="eyebrow">{repo}</span>
                <span className="font-mono text-[10px] text-mute">{workspaces.length}</span>
              </div>
              <div className="overflow-hidden rounded-[10px] border border-line">
                {workspaces.map((place, i) => (
                  <Place key={place.id} place={place} first={i === 0} />
                ))}
              </div>
            </section>
          ))}

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

/** One workspace and the agents in it, as a row you can open. */
function Place({ place, first }: { place: Workspace; first: boolean }) {
  // What the place as a whole is doing, which is not any one agent's status.
  // `unfinished` was the wrong question here — it means "still holds a host",
  // so an idle workspace and a busy one both answered yes and every row said
  // "working".
  const anyWaiting = place.runs.some(needsYou);
  const working = place.runs.some(inFlight);
  const doing = working ? "working" : anyWaiting ? "waiting" : "idle";

  return (
    <Link
      href={`/sessions/${place.id}`}
      className={`flex items-center gap-3 px-3.5 py-2.5 transition-colors hover:bg-raise/50 ${
        first ? "" : "border-t border-line"
      }`}
    >
      <Signal status={place.runs[0].status} size={6} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13.5px] text-text">{place.name}</span>
          {anyWaiting && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ember" />}
        </div>
        <div className="truncate font-mono text-[11px] text-mute">{place.branch ?? "—"}</div>
      </div>

      {/* Which agents are in it, rather than how many: two claudes and a codex
          is a different place from three claudes, and the count says neither. */}
      <div className="flex shrink-0 items-center gap-2">
        {place.runs.slice(0, 4).map((run) => (
          <span key={run.id} className="flex items-center gap-1" title={AGENT_SHORT[run.agent]}>
            <AgentMark agent={run.agent} size={11} className="text-mute" />
          </span>
        ))}
        {place.runs.length > 4 && (
          <span className="font-mono text-[10px] text-mute">+{place.runs.length - 4}</span>
        )}
      </div>

      <span className="w-12 shrink-0 text-right font-mono text-[10.5px] text-mute">
        {elapsed(minutesSince(place.runs[0].createdAt))}
      </span>

      <span
        className={`w-14 shrink-0 text-right text-[11px] ${
          doing === "waiting" ? "text-ember" : doing === "working" ? "text-dim" : "text-mute"
        }`}
      >
        {doing}
      </span>
    </Link>
  );
}

/**
 * The one destructive control, and the reason this page exists at all.
 *
 * Counted in workspaces, because that is what somebody loses: "48 ended" is a
 * number nobody recognises, and it was six places.
 */
function EndEverything({ workspaces }: { workspaces: number }) {
  const [asking, setAsking] = useState(false);
  const cache = useQueryClient();
  const end = useEndAllSessions();

  if (workspaces === 0) return null;

  return (
    <>
      <button
        onClick={() => setAsking(true)}
        className="ml-auto text-[12px] text-mute transition-colors hover:text-ember"
      >
        End everything…
      </button>

      {asking && (
        <Modal onClose={() => setAsking(false)} title="End everything">
          <div className="px-1">
            <p className="text-[13.5px] leading-[1.6] text-dim">
              {workspaces === 1 ? "One workspace" : `${workspaces} workspaces`} and every agent in
              them. Their worktrees go, and anything not pushed goes with them.
            </p>
            <p className="mt-2 text-[12.5px] leading-[1.6] text-mute">
              Branches already pushed stay on the remote. A host that is not answering keeps its
              workspaces until it comes back.
            </p>

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                onClick={() => setAsking(false)}
                className="rounded-[8px] px-3 py-1.5 text-ui text-mute transition-colors hover:text-text"
              >
                Cancel
              </button>
              <button
                disabled={end.isPending}
                onClick={() =>
                  end.mutate(undefined, {
                    onSettled: () => {
                      setAsking(false);
                      cache.invalidateQueries({ queryKey: getListSessionsQueryKey() });
                    },
                  })
                }
                className="rounded-[8px] border border-ember-deep bg-ember/[0.08] px-3 py-1.5 text-ui text-ember transition-colors hover:bg-ember/[0.16] disabled:opacity-50"
              >
                {end.isPending ? "Ending…" : "End everything"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

/** A workspace, assembled from the sessions that name it. */
type Workspace = {
  id: string;
  name: string;
  branch?: string;
  runs: Session[];
};

/**
 * Repository → workspace → runs.
 *
 * A session's `workspaceId` is the place it works in, and the first session of
 * a workspace carries the workspace's own id — so grouping by it and taking the
 * name from the first run gives the same three levels the rail draws.
 */
function group(sessions: Session[]): {
  groups: [string, Workspace[]][];
  total: number;
} {
  const byRepo = new Map<string, Map<string, Workspace>>();

  // What needs you first, then most recent — so the row worth opening is the
  // one nearest the top of its group.
  const ordered = [...sessions].sort((a, b) => {
    if (needsYou(a) !== needsYou(b)) return needsYou(a) ? -1 : 1;
    return b.createdAt.localeCompare(a.createdAt);
  });

  for (const session of ordered) {
    const repo = session.repo ?? "no repository";
    const id = session.workspaceId ?? session.id;

    const places = byRepo.get(repo) ?? new Map<string, Workspace>();
    byRepo.set(repo, places);

    const held = places.get(id);
    if (held) {
      held.runs.push(session);
      continue;
    }
    places.set(id, {
      id,
      name: session.name,
      branch: session.branch ?? undefined,
      runs: [session],
    });
  }

  const groups: [string, Workspace[]][] = [...byRepo].map(([repo, places]) => [
    repo,
    [...places.values()],
  ]);
  const total = groups.reduce((n, [, places]) => n + places.length, 0);

  return { groups, total };
}
