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
import { useListAccounts } from "@/src/api/generated/accounts/accounts";
import { useMe } from "@/src/api/generated/auth/auth";
import { useSetupState } from "@/src/api/generated/setup/setup";
import { useGetUpdates } from "@/src/api/generated/updates/updates";
import { showsDot } from "@/src/api/updates";
import { useListTrackers } from "@/src/api/generated/trackers/trackers";
import {
  getListSessionsQueryKey,
  useEndAllSessions,
  useGetSession,
  useListFiles,
  useSessionDiff,
} from "@/src/api/generated/sessions/sessions";
import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { FileDiff, Repo, Session, Task, TaskKind, TaskState } from "@/src/api/generated/model";
import { isLive } from "~/mock/http";
import { STATE, TASKS, type BackendId } from "~/mock/backends";
import { useFixtures } from "~/mock/socket";
import { useBackendKey } from "~/backend";

/** Everything a screen needs to know about where its data came from. */
export type Feed<T> = { data: T; live: boolean; loading: boolean; error: string | null };

/** What the server said, off any thrown thing. */
export function why(e: unknown): string {
  return (e as { message?: string })?.message ?? "That didn't work.";
}

function whyOrNull(e: unknown): string | null {
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
    ? { data: q.data ?? [], live: true, loading: q.isPending, error: q.error ? why(q.error) : null }
    : { data: STATE[id as BackendId] ?? [], live: false, loading: false, error: null };
}

/**
 * One session, by id — the one a workspace is opened on.
 *
 * Its own query rather than a lookup in the list, because the header and the
 * verbs on offer follow it, and `applyEvent` keeps this key fresh from the
 * stream independently of the list.
 */
export function useSession(id: string | null): Feed<Session | null> {
  const key = useBackendKey();
  const live = isLive(key);
  useFixtures();

  const q = useGetSession(id ?? "", { query: { enabled: live && !!id } });

  if (live) {
    return { data: q.data ?? null, live: true, loading: !!id && q.isPending, error: q.error ? why(q.error) : null };
  }
  const found = (STATE[key as BackendId] ?? []).find((s) => s.id === id || s.workspaceId === id) ?? null;
  return { data: found, live: false, loading: false, error: null };
}

/** End every workspace on this server. */
export function useEndAll() {
  const cache = useQueryClient();
  const end = useEndAllSessions();
  return {
    pending: end.isPending,
    go: () =>
      end.mutate({ data: {} }, {
        onSuccess: () => cache.invalidateQueries({ queryKey: getListSessionsQueryKey() }),
      }),
  };
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
        error: q.error ? why(q.error) : null,
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
    ? { data: q.data ?? [], live: true, loading: q.isPending, error: q.error ? why(q.error) : null }
    : { data: fallback, live: false, loading: false, error: null };
}

export function useHosts() {
  const live = isLive(useBackendKey());
  const q = useListHosts({ query: { enabled: live } });
  return { data: q.data ?? [], live, loading: live && q.isPending, error: q.error ? why(q.error) : null };
}

export function useAgents() {
  const live = isLive(useBackendKey());
  const q = useListAgents({ query: { enabled: live } });
  return { data: q.data ?? [], live, loading: live && q.isPending, error: q.error ? why(q.error) : null };
}

/** GitHub and the rest: whether they are connected, and as whom. */
export function useProviders() {
  const live = isLive(useBackendKey());
  const q = useListProviders({ query: { enabled: live } });
  return { data: q.data ?? [], live, loading: live && q.isPending, error: q.error ? why(q.error) : null };
}

/**
 * Whether this server still needs something before it is usable: a password
 * that came from a file, or an organisation with no name. Asked on every visit,
 * because both are facts about the server rather than about this Mac.
 */
export function useGate(): { setup: boolean; ready: boolean } {
  const live = isLive(useBackendKey());
  const me = useMe({ query: { enabled: live, staleTime: 60_000 } });
  const setup = useSetupState({ query: { enabled: live, staleTime: 60_000 } });
  if (!live) return { setup: false, ready: true };
  const needs = !!me.data?.user?.mustChangePassword || (!!setup.data && !setup.data.completed);
  return { setup: needs, ready: !me.isPending && !setup.isPending };
}

/** The dot on Updates in the rail. Asked rarely: the answer changes monthly. */
export function useUpdatesDot(): boolean {
  const live = isLive(useBackendKey());
  const q = useGetUpdates({ query: { enabled: live, refetchInterval: 10 * 60_000, retry: false, staleTime: 60_000 } });
  return live && showsDot(q.data);
}

/** Named agent connections — whose subscription a session runs on. */
export function useAccounts() {
  const live = isLive(useBackendKey());
  const q = useListAccounts({ query: { enabled: live } });
  return { data: q.data ?? [], live, loading: live && q.isPending, error: q.error ? why(q.error) : null };
}

/** Where issues come from. */
export function useTrackers() {
  const live = isLive(useBackendKey());
  const q = useListTrackers({ query: { enabled: live } });
  return { data: q.data ?? [], live, loading: live && q.isPending, error: q.error ? why(q.error) : null };
}

/** One directory of a session's workspace, off the worker. */
export function useWorkspaceFiles(sessionId: string | null, path: string) {
  const live = isLive(useBackendKey());
  const on = live && !!sessionId;
  const q = useListFiles(sessionId ?? "", { path } as never, { query: { enabled: on } });
  return { data: q.data ?? [], live: on, loading: on && q.isPending, error: q.error ? why(q.error) : null };
}

/** A changed file: `path` as the server names it, `at` where it sits in the workspace. */
export type ChangedFile = FileDiff & { at: string };

/**
 * What a session has changed, as the control plane sees it — polled the way
 * the web does, since edits are not on the event stream.
 *
 * With one checkout the server leaves paths repository-relative (the ship
 * flow wants them that way); with several it puts the checkout's directory in
 * front. The tree and the tabs are workspace-relative either way, so `at` is
 * the path with the directory always in front.
 */
export function useDiff(session: Pick<Session, "id" | "checkouts"> | null) {
  const live = isLive(useBackendKey());
  const on = live && !!session;
  const q = useSessionDiff(session?.id ?? "", undefined, { query: { enabled: on, refetchInterval: 8000 } });
  const data = useMemo<ChangedFile[]>(() => {
    const files = (q.data ?? []) as FileDiff[];
    const dirs = (session?.checkouts ?? []).map((c) => c.path).filter((p): p is string => !!p);
    const only = dirs.length === 1 ? dirs[0] : null;
    return files.map((d) => ({ ...d, at: only && !d.path.startsWith(`${only}/`) ? `${only}/${d.path}` : d.path }));
  }, [q.data, session?.checkouts]);
  return { data, live: on, loading: on && q.isPending, error: q.error ? why(q.error) : null };
}
