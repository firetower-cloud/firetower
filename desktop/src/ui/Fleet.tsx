/**
 * Every server's work, on one screen.
 *
 * The only surface here that `web/` does not already have, and the only one it
 * could not: it is true exactly once a client holds N backends.
 *
 * Built from the same vocabulary as the rail rather than beside it — `group()`
 * for repositories and workspaces, `doing()` for what a place is up to,
 * `Signal` for status, `AgentMark` for who is in it, branch in mono under the
 * name. A second way of drawing the same fleet is how two screens drift apart.
 */
import { useMemo } from "react";
import { CircleDashed, CircleSlash2 } from "lucide-react";
import { Signal } from "@/components/Signal";
import { AgentMark } from "@/components/AgentMark";
import { GithubMark, Icon, PageHead } from "@/components/ui";
import { doing, group, shortRepo, type Workspace } from "@/src/api/workspaces";
import { elapsed, minutesSince, needsYou, NEEDS_YOU } from "@/src/api/view";
import { BACKENDS, STATE, type Backend } from "~/mock/backends";
import { useFixtures } from "~/mock/socket";
import { navigate } from "~/shims/next-navigation";

/** Ember, summed over every server. What goes on the dock. */
export function waitingAcross(): number {
  return BACKENDS.reduce(
    (n, b) => n + STATE[b.id].filter((s) => NEEDS_YOU.includes(s.status)).length,
    0,
  );
}

export function Fleet() {
  useFixtures();

  const fleets = useMemo(
    () =>
      BACKENDS.map((b) => {
        const live = STATE[b.id].filter((s) => s.status !== "Ended");
        return { backend: b, repos: group(live) };
      }),
    // Recomputed whenever the fixtures change; `useFixtures` is what re-renders.
    [],
  );

  const waiting = waitingAcross();

  return (
    <div className="mx-auto w-full max-w-[1100px] px-6 py-6">
      <PageHead
        eyebrow="Everything"
        title={
          waiting > 0
            ? `${waiting} waiting on you, across ${BACKENDS.length} servers.`
            : `Nothing waiting, across ${BACKENDS.length} servers.`
        }
      />

      <div className="mt-6 space-y-8">
        {fleets.map(({ backend, repos }) => (
          <section key={backend.id}>
            <div className="mb-2 flex items-center gap-2">
              <span className="server-mark grid h-5 w-5 place-items-center" data-reach={backend.reach}>
                {backend.mark}
              </span>
              <span className="text-title text-bone">{backend.org}</span>
              <span className="text-meta text-mute">{backend.user}</span>
              {backend.reach === "unreachable" && (
                <span className="flex items-center gap-1 text-meta text-mute">
                  <Icon of={CircleSlash2} size={12} />
                  can&rsquo;t reach it — showing what was last known
                </span>
              )}
            </div>

            <div className={backend.reach === "unreachable" ? "stale" : ""}>
              {repos.groups.length === 0 && (
                <p className="px-2 py-2 text-ui text-mute">Nothing running.</p>
              )}

              {repos.groups.map(([repo, places]) => (
                <div key={repo} className="mb-3">
                  <div className="flex items-center gap-1.5 px-2 py-1.5">
                    {repo === "no repository" ? (
                      <Icon of={CircleDashed} size={12} className="text-mute" />
                    ) : (
                      <GithubMark size={13} className="text-dim" />
                    )}
                    <span className="truncate text-ui font-medium text-bone">{shortRepo(repo)}</span>
                    <span className="font-mono text-micro text-mute">{places.length}</span>
                  </div>

                  {places.map((place) => (
                    <Place key={place.id} place={place} backend={backend} />
                  ))}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

/**
 * One workspace. The same row as the rail's, given the room a page has: the
 * branch stays in mono under the name, and what the rail has no width for —
 * which agents, and what the place as a whole is doing — is spelled out.
 */
function Place({ place, backend }: { place: Workspace; backend: Backend }) {
  const state = doing(place);
  const lead = place.runs[0];

  return (
    <button
      onClick={() => navigate(`/sessions/${place.id}`)}
      className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors duration-150 hover:bg-raise/60"
    >
      <Signal status={lead.status} size={6} />

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-ui text-dim">{place.name}</span>
          {place.runs.some(needsYou) && (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ember" />
          )}
        </span>
        <span className="mt-0.5 block truncate font-mono text-micro text-mute">
          {place.branch ?? "—"}
        </span>
      </span>

      <span className="flex w-[92px] shrink-0 items-center gap-1">
        {place.runs.slice(0, 3).map((run) => (
          <AgentMark key={run.id} agent={run.agent} size={11} className="text-mute" />
        ))}
      </span>

      <span className="w-[70px] shrink-0 text-meta text-mute">
        {state === "waiting" ? "your move" : state}
      </span>

      <span className="w-[48px] shrink-0 text-right font-mono text-micro text-mute">
        {elapsed(minutesSince(lead.createdAt))}
      </span>
    </button>
  );
}
