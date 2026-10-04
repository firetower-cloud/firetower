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
import { useListDirectories } from "~/api/generated/access/access";
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

/**
 * What the server said, off any thrown thing.
 *
 * With one substitution. A password that has to be replaced is refused on
 * every path at once, so every list on screen asks its own question and gets
 * the same sentence back — and a sentence written as a reason, repeated eight
 * times down a rail, reads as eight things being broken. The screen that
 * explains it is already up; these are the places behind it, and what they owe
 * is to be brief and to agree with it.
 */
export function why(e: unknown): string {
  return said(e) ?? "That didn't work.";
}

/* The two fallbacks differ on purpose — one ends a sentence of its own, the
   other is dropped into one — so they are kept, and only the reading of the
   error is shared. */
function whyOrNull(e: unknown): string | null {
  if (!e) return null;
  return said(e) ?? "that request did not work";
}

function said(e: unknown): string | null {
  if ((e as { code?: string })?.code === "PasswordChangeRequired") {
    return "Replace your password to see this.";
  }
  return (e as { message?: string })?.message ?? null;
}

/**
 * Every session this person can see.
 *
 * **Polled, because this one list is most of the app.** The rail, the chip
 * strip in a workspace and the dashboard all read it, so anything that happens
 * to somebody else's fleet — a colleague starting a second agent in a
 * workspace you are in, a workspace being shared with you — only appeared when
 * something else happened to invalidate it. Which in practice meant
 * navigating away and back.
 *
 * Ten seconds: below what anybody reads as stale, and one small request per
 * client per ten seconds is not worth a second mechanism. The transcript is
 * already live over the socket, so this is for the shape of the fleet rather
 * than for anything inside a conversation.
 *
 * A broadcast on that socket would be cheaper and instant, and needs the
 * server to work out who should hear about each change — the access predicate,
 * per connected client. Worth it when polling proves too slow or too chatty,
 * and not before.
 */
export function useSessions(): Feed<Session[]> {
  const q = useListSessions(undefined, { query: { refetchInterval: 10_000 } });
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
    /* Nothing, unless this question is one we are currently allowed to ask.
       React Query hands back the last good answer for a query that is failing
       *and* for one that has been switched off, and a revoked key produces the
       second: the tracker stops reporting itself as connected, so the screen
       disables the query, so it never errors, so the cache answers as if
       nothing had happened. A shared Linear key filed back out of a directory
       left everybody who had reached through it reading the tasks it had
       fetched, under a panel telling them Linear was not connected.

       Right for a flaky network, wrong for access that has been taken away:
       that has to look like it has been taken away. */
    data: enabled && !q.error ? (page?.tasks ?? []) : [],
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
 * Whether this server still needs something before it is usable, and which of
 * two very different somethings it is. Asked on every visit, because both are
 * facts about the server rather than about this Mac.
 *
 * `locked` is a password the server will not accept any work under. It is kept
 * apart from `setup` rather than folded into one "needs something" flag,
 * because the two have opposite answers: setting up is finished here, and a
 * password is replaced in a browser. Folded together, the app showed its own
 * setup wizard to somebody whose only remaining task it cannot perform.
 *
 * It is read from `auth/me` on every visit rather than remembered from the
 * sign-in. An administrator can reset a password under a running app, and the
 * stored user would still say everything is fine while every request was being
 * refused.
 */
export function useGate(): { setup: boolean; locked: boolean; ready: boolean } {
  const me = useMe({ query: { staleTime: 60_000 } });
  const setup = useSetupState({ query: { staleTime: 60_000 } });
  return {
    setup: !!setup.data && !setup.data.completed,
    locked: !!me.data?.user?.mustChangePassword,
    ready: !me.isPending && !setup.isPending,
  };
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

/**
 * The directories this person can reach, with what they may do in each.
 *
 * Where something is filed decides who can see it, so this is what the "Filed
 * in" choice is built from and what turns the `d/<slug>` in a path into a name.
 * Match on `slug`, not on `id`: the slug is the part that appears in a path, and
 * the name is free to change without anything moving.
 *
 * Only the ones that can be worked in are somewhere to put new work — being
 * allowed to look at a directory is not being allowed to file your own work
 * there, where you could then not follow it.
 */
export function useDirectories() {
  const q = useListDirectories();
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
export function useDiff(
  session: Pick<Session, "id" | "checkouts"> | null,
  since: DiffSince = "Base",
  /* For a caller that marks a tree rather than drawing a patch. The answer
     carries `fresh` and the line counts and nothing else, which is a few
     hundred bytes where the patches were megabytes — on an eight-second
     poll — and the worker never runs `git diff` at all. */
  namesOnly = false,
) {
  const on = !!session;
  const q = useSessionDiff(session?.id ?? "", { since, ...(namesOnly ? { namesOnly } : {}) }, { query: { enabled: on, refetchInterval: 8000 } });
  const data = useMemo<ChangedFile[]>(() => {
    const files = (q.data ?? []) as FileDiff[];
    const dirs = (session?.checkouts ?? []).map((c) => c.path).filter((p): p is string => !!p);
    const only = dirs.length === 1 ? dirs[0] : null;
    return files.map((d) => ({ ...d, at: only && !d.path.startsWith(`${only}/`) ? `${only}/${d.path}` : d.path }));
  }, [q.data, session?.checkouts]);
  return { data, loading: on && q.isPending, error: q.error ? why(q.error) : null };
}
