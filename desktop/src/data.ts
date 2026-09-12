/**
 * What the screens read.
 *
 * One hook per thing, and each one answers from the generated client when the
 * current backend is a real Firetower and from the fixtures when it is not.
 * The screens are written once either way — which is the only reason the
 * prototype could keep being reviewable while the real wiring landed.
 *
 * The fixture branch is not a stub of the real one: it is the demo, and it has
 * to keep working with no server in the room.
 */
import { useListSessions } from "@/src/api/generated/sessions/sessions";
import { useListRepos } from "@/src/api/generated/repos/repos";
import { useListTasks } from "@/src/api/generated/tasks/tasks";
import { useListHosts } from "@/src/api/generated/hosts/hosts";
import { useListAgents } from "@/src/api/generated/agents/agents";
import { useListProviders } from "@/src/api/generated/providers/providers";
import { useListTrackers } from "@/src/api/generated/trackers/trackers";
import { useListFiles, useSessionDiff } from "@/src/api/generated/sessions/sessions";
import type { Repo, Session, Task, TaskKind, TaskState } from "@/src/api/generated/model";
import { isLive } from "~/mock/http";
import { STATE, TASKS, type BackendId } from "~/mock/backends";
import { useFixtures } from "~/mock/socket";
import { useBackendKey } from "~/backend";

/** Everything a screen needs to know about where its data came from. */
export type Feed<T> = { data: T; live: boolean; loading: boolean; error: string | null };

function why(e: unknown): string | null {
  if (!e) return null;
  const m = (e as { message?: string })?.message;
  return m ?? "that request did not work";
}

export function useSessions(): Feed<Session[]> {
  const id = useBackendKey();
  const live = isLive(id);
  useFixtures();

  const q = useListSessions(undefined, { query: { enabled: live } });

  return live
    ? { data: q.data ?? [], live: true, loading: q.isPending, error: why(q.error) }
    : { data: STATE[id as BackendId] ?? [], live: false, loading: false, error: null };
}

export function useTasks(): Feed<Task[]> {
  const id = useBackendKey();
  const live = isLive(id);

  // Open issues assigned to nobody in particular — the same default the web
  // build's Tasks page opens with.
  const q = useListTasks(
    { kind: "issue" as TaskKind, state: "open" as TaskState },
    { query: { enabled: live } },
  );

  return live
    ? {
        data: (q.data as { tasks?: Task[] } | undefined)?.tasks ?? [],
        live: true,
        loading: q.isPending,
        error: why(q.error),
      }
    : { data: TASKS[id as BackendId] ?? [], live: false, loading: false, error: null };
}

export function useRepos() {
  const id = useBackendKey();
  const live = isLive(id);
  const q = useListRepos({ query: { enabled: live } });

  const fallback: Repo[] = [
    ...new Set((STATE[id as BackendId] ?? []).map((s) => s.repo).filter(Boolean)),
  ].map((slug, i) => ({
    id: `r_${i}` as Repo["id"],
    slug: slug as string,
    remote: `git@github.com:${slug}.git`,
    defaultBranch: "main",
  }));

  return live
    ? { data: q.data ?? [], live: true, loading: q.isPending, error: why(q.error) }
    : { data: fallback, live: false, loading: false, error: null };
}

export function useHosts() {
  const live = isLive(useBackendKey());
  const q = useListHosts({ query: { enabled: live } });
  return { data: q.data ?? [], live, loading: live && q.isPending, error: why(q.error) };
}

export function useAgents() {
  const live = isLive(useBackendKey());
  const q = useListAgents({ query: { enabled: live } });
  return { data: q.data ?? [], live, loading: live && q.isPending, error: why(q.error) };
}

/** GitHub and the rest: whether they are connected, and as whom. */
export function useProviders() {
  const live = isLive(useBackendKey());
  const q = useListProviders({ query: { enabled: live } });
  return { data: q.data ?? [], live, loading: live && q.isPending, error: why(q.error) };
}

/** Where issues come from. */
export function useTrackers() {
  const live = isLive(useBackendKey());
  const q = useListTrackers({ query: { enabled: live } });
  return { data: q.data ?? [], live, loading: live && q.isPending, error: why(q.error) };
}

/** One directory of a session's workspace, off the worker. */
export function useWorkspaceFiles(sessionId: string | null, path: string) {
  const live = isLive(useBackendKey());
  const on = live && !!sessionId;
  const q = useListFiles(sessionId ?? "", { path } as never, { query: { enabled: on } });
  return { data: q.data ?? [], live: on, loading: on && q.isPending, error: why(q.error) };
}

/** What a session has changed, as the control plane sees it. */
export function useDiff(sessionId: string | null) {
  const live = isLive(useBackendKey());
  const on = live && !!sessionId;
  const q = useSessionDiff(sessionId ?? "", undefined, { query: { enabled: on } });
  return { data: q.data ?? [], live: on, loading: on && q.isPending, error: why(q.error) };
}
