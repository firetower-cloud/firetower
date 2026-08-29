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
 * So: **home is about the fleet, a workspace is about the work.** Anything that
 * is not about one worktree lives here, and the workspace screen is only tabs
 * and the rail that switches between them.
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
import { useListHosts } from "@/src/api/generated/hosts/hosts";
import { useLogout, useMe } from "@/src/api/generated/auth/auth";
import { forgetToken } from "@/src/api/http";
import type { Session } from "@/src/api/generated/model";
import { Mark, Signal } from "@/components/Signal";
import { AgentMark, AGENT_SHORT } from "@/components/AgentMark";
import { Modal } from "@/components/Modal";
import { NewWorkspace } from "@/components/NewWorkspace";
import { elapsed, inFlight, minutesSince, needsYou } from "@/src/api/view";

/** The pages that are still pages. */
const ELSEWHERE = [
  ["/repos", "Repos"],
  ["/agents", "Agents"],
  ["/secrets", "Secrets"],
  ["/compute", "Compute"],
] as const;

export function Overview() {
  const router = useRouter();
  const { data: sessions = [], isPending } = useListSessions();
  const [starting, setStarting] = useState<{ repo?: string } | null>(null);

  const live = useMemo(() => sessions.filter((s) => s.status !== "Ended"), [sessions]);
  const waiting = live.filter(needsYou);

  // Repository → workspace → the runs in it, the same three levels the rail
  // draws. One shape for both, because moving between them should not mean
  // learning a second way to read the same fleet.
  const repos = useMemo(() => group(live), [live]);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-ground">
      <header className="flex shrink-0 items-center gap-3 border-b border-line px-5 py-3">
        <span className="text-bone">
          <Mark size={20} />
        </span>
        <span className="font-narrow text-[12px] font-semibold tracking-[0.22em] text-bone uppercase">
          Firetower
        </span>

        <nav className="ml-auto flex items-center gap-1">
          {ELSEWHERE.map(([href, label]) => (
            <Link
              key={href}
              href={href}
              className="rounded-[6px] px-2 py-1 text-[12px] text-mute transition-colors hover:bg-raise/60 hover:text-ember"
            >
              {label}
            </Link>
          ))}
        </nav>

        <WhoAmI />
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[900px] px-5 py-6">
          {waiting.length > 0 && (
            <Link
              href={`/sessions/${waiting[0].workspaceId ?? waiting[0].id}`}
              className="mb-5 flex items-center gap-2.5 rounded-[10px] border border-ember-deep bg-ember/[0.06] px-3.5 py-2.5 transition-colors hover:bg-ember/[0.1]"
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ember" />
              <span className="font-narrow text-[11px] font-semibold tracking-[0.14em] text-ember uppercase">
                Waiting on you
              </span>
              <span className="font-mono text-[12px] text-ember">{waiting.length}</span>
              <span className="ml-auto text-[12px] text-ember/70">Go to the first →</span>
            </Link>
          )}

          <div className="mb-4 flex items-center gap-3">
            <h1 className="font-narrow text-[13px] font-semibold tracking-[0.14em] text-dim uppercase">
              Workspaces
            </h1>
            <span className="font-mono text-[11px] text-mute">{repos.total}</span>
            <button
              onClick={() => setStarting({})}
              className="ml-auto rounded-[8px] border border-dashed border-line px-3 py-1.5 text-ui text-mute transition-colors hover:border-ember/40 hover:text-ember"
            >
              + New workspace
            </button>
          </div>

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
        </div>
      </main>

      <footer className="flex shrink-0 items-center gap-4 border-t border-line px-5 py-2.5">
        <Hosts />
        <EndEverything workspaces={repos.total} />
      </footer>

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

function Hosts() {
  const { data: hosts = [] } = useListHosts();
  if (hosts.length === 0) return null;
  const up = hosts.filter((h) => h.state === "Online").length;

  return (
    <Link href="/compute" className="group flex items-center gap-2" title="Compute">
      <span className="eyebrow transition-colors group-hover:text-ember">Hosts</span>
      <span className="font-mono text-[11px] text-mute">
        {up}/{hosts.length}
      </span>
      <span className="flex items-center gap-1">
        {hosts.slice(0, 6).map((h) => (
          <span
            key={h.name}
            title={h.name}
            className={`h-1.5 w-1.5 rounded-full ${
              h.state === "Online" ? "bg-sage" : "border border-mute"
            }`}
          />
        ))}
      </span>
    </Link>
  );
}

function WhoAmI() {
  const { data } = useMe();
  const out = useLogout();

  if (!data) return null;

  return (
    <div className="flex items-center gap-3 border-l border-line pl-3">
      <span className="truncate text-[12.5px] text-dim">{data.user.username}</span>
      <button
        onClick={() =>
          out.mutate(undefined, {
            // Whether or not the server managed to delete the row, this browser
            // is done with the token.
            onSettled: () => {
              forgetToken();
              // eslint-disable-next-line @next/next/no-location-assign-relative-destination
              window.location.assign("/login");
            },
          })
        }
        className="text-[11.5px] text-mute transition-colors hover:text-text"
      >
        Sign out
      </button>
    </div>
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
