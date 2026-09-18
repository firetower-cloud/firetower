/**
 * What the screens read: one hook per thing, off the generated client, with
 * the loading and error states already shaped for a screen.
 */
import { useListSessions } from "~/api/generated/sessions/sessions";
import { useListRepos } from "~/api/generated/repos/repos";
import { useListTasks } from "~/api/generated/tasks/tasks";
import { useListHosts } from "~/api/generated/hosts/hosts";
import { useListAgents } from "~/api/generated/agents/agents";
import { useListProviders } from "~/api/generated/providers/providers";
import { useListAccounts } from "~/api/generated/accounts/accounts";
import { useMe } from "~/api/generated/auth/auth";
import { useSetupState } from "~/api/generated/setup/setup";
import { useGetUpdates } from "~/api/generated/updates/updates";
import { showsDot } from "~/api/updates";
import { useListTrackers, useListTrackerScopes } from "~/api/generated/trackers/trackers";
import {
  getListSessionsQueryKey,
  useGetSession,
  useListFiles,
  useSessionDiff,
} from "~/api/generated/sessions/sessions";
import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DiffSince, FileDiff, ListTasksParams, Page, Repo, Session, Task, TaskScope } from "~/api/generated/model";

/** Everything a screen needs to know about where its data came from. */
export type Feed<T> = { data: T; loading: boolean; error: string | null };

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
  const q = useListSessions();
  return { data: q.data ?? [], loading: q.isPending, error: q.error ? why(q.error) : null };
}

/**
 * One session, by id — the one a workspace is opened on.
 *
 * Its own query rather than a lookup in the list, because the header and the
 * verbs on offer follow it, and `applyEvent` keeps this key fresh from the
 * stream independently of the list.
 */
export function useSession(id: string | null): Feed<Session | null> {
  const q = useGetSession(id ?? "", { query: { enabled: !!id } });
  return { data: q.data ?? null, loading: !!id && q.isPending, error: q.error ? why(q.error) : null };
}

/**
 * One page of tasks, plus what paging needs to know.
 *
 * `total` is null when the source will not say — Linear's connection carries
 * no count, so the heading falls back to what is on the page. `next` is the
 * cursor to resume from, and null for a source that pages by number.
 */
export type Tasks = Feed<Task[]> & { total: number | null; more: boolean; next: string | null };

/**
 * What could be worked on, from one tracker.
 *
 * The tracker is a parameter rather than a default, because `/tasks` answers
 * for one source per request and leaving it off means GitHub — which is how a
 * connected Linear ended up invisible on this screen.
 *
 * Nothing is filtered here. The chips and the box are query parameters the
 * source reads in its own dialect, so a row that arrives is a row to show;
 * narrowing it again locally only drops what the server already answered.
 */
export function useTasks(ask: ListTasksParams, enabled = true): Tasks {
  const q = useListTasks(ask, { query: { enabled } });
  const page = q.data as Page | undefined;
  return {
    data: page?.tasks ?? [],
    // `isPending` stays true for a query that was never allowed to run, which
    // would leave "Reading your trackers…" on screen for a tracker nobody has
    // connected yet.
    loading: enabled && q.isPending,
    error: q.error ? why(q.error) : null,
    total: page?.total ?? null,
    more: page?.more ?? false,
    next: page?.next ?? null,
  };
}

export function useRepos(): Feed<Repo[]> {
  const q = useListRepos();
  return { data: q.data ?? [], loading: q.isPending, error: q.error ? why(q.error) : null };
}

export function useHosts() {
  const q = useListHosts();
  return { data: q.data ?? [], loading: q.isPending, error: q.error ? why(q.error) : null };
}

export function useAgents() {
  const q = useListAgents();
  return { data: q.data ?? [], loading: q.isPending, error: q.error ? why(q.error) : null };
}

/** GitHub and the rest: whether they are connected, and as whom. */
export function useProviders() {
  const q = useListProviders();
  return { data: q.data ?? [], loading: q.isPending, error: q.error ? why(q.error) : null };
}

/**
 * Whether this server still needs something before it is usable: a password
 * that came from a file, or an organisation with no name. Asked on every visit,
 * because both are facts about the server rather than about this Mac.
 */
export function useGate(): { setup: boolean; ready: boolean } {
  const me = useMe({ query: { staleTime: 60_000 } });
  const setup = useSetupState({ query: { staleTime: 60_000 } });
  const needs = !!me.data?.user?.mustChangePassword || (!!setup.data && !setup.data.completed);
  return { setup: needs, ready: !me.isPending && !setup.isPending };
}

/** The dot on Updates in the rail. Asked rarely: the answer changes monthly. */
export function useUpdatesDot(): boolean {
  const q = useGetUpdates({ query: { refetchInterval: 10 * 60_000, retry: false, staleTime: 60_000 } });
  return showsDot(q.data);
}

/** Named agent connections — whose subscription a session runs on. */
export function useAccounts() {
  const q = useListAccounts();
  return { data: q.data ?? [], loading: q.isPending, error: q.error ? why(q.error) : null };
}

/** Where issues come from. */
export function useTrackers() {
  const q = useListTrackers();
  return { data: q.data ?? [], loading: q.isPending, error: q.error ? why(q.error) : null };
}

/** What one tracker's list can be narrowed to: repositories, or teams. */
export function useTrackerScopes(id: string, enabled: boolean): Feed<TaskScope[]> {
  const q = useListTrackerScopes(id, { query: { enabled: enabled && !!id } });
  return { data: q.data ?? [], loading: enabled && q.isPending, error: q.error ? why(q.error) : null };
}

/** One directory of a session's workspace, off the worker. */
export function useWorkspaceFiles(sessionId: string | null, path: string) {
  const on = !!sessionId;
  const q = useListFiles(sessionId ?? "", { path } as never, { query: { enabled: on } });
  return { data: q.data ?? [], loading: on && q.isPending, error: q.error ? why(q.error) : null };
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
export function useDiff(session: Pick<Session, "id" | "checkouts"> | null, since: DiffSince = "Base") {
  const on = !!session;
  const q = useSessionDiff(session?.id ?? "", { since }, { query: { enabled: on, refetchInterval: 8000 } });
  const data = useMemo<ChangedFile[]>(() => {
    const files = (q.data ?? []) as FileDiff[];
    const dirs = (session?.checkouts ?? []).map((c) => c.path).filter((p): p is string => !!p);
    const only = dirs.length === 1 ? dirs[0] : null;
    return files.map((d) => ({ ...d, at: only && !d.path.startsWith(`${only}/`) ? `${only}/${d.path}` : d.path }));
  }, [q.data, session?.checkouts]);
  return { data, loading: on && q.isPending, error: q.error ? why(q.error) : null };
}
