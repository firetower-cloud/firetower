"use client";

/**
 * Starting another agent in a workspace, wherever that is asked for.
 *
 * Every agent the fleet knows about, gated on the machine *this workspace* is
 * on — a workspace is one directory on one host, so an agent anywhere else
 * could not see it, and there is no choosing.
 *
 * Unavailable ones stay listed and say why. Vanishing from a menu looks like
 * the thing does not exist and leaves nowhere to learn what is missing, which
 * is the same rule the create dialog follows.
 *
 * Lifted out of `TabBar` when the phone grew a `⋯` menu that offers the same
 * thing. The list, the availability rule and the reasons it prints are one
 * piece of knowledge and were about to become two.
 */

import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateSession,
  useGetSession,
  getListSessionsQueryKey,
} from "@/src/api/generated/sessions/sessions";
import { useListAgents } from "@/src/api/generated/agents/agents";
import { useListHosts } from "@/src/api/generated/hosts/hosts";
import type { AgentView } from "@/src/api/generated/model";
import { useCurrentSession } from "@/src/workspace/tabs";

/**
 * Why this agent cannot be started here, or nothing.
 *
 * The same two questions the create dialog asks, in the same order: is it on
 * the machine at all, and can it authenticate there. A subscription lives in
 * the agent's own config on the host it was signed in on, so one machine being
 * signed in says nothing about another.
 */
export function unavailable(
  agent: AgentView,
  hostId?: string,
  hostName?: string,
): string | undefined {
  if (!agent.supported) return "Firetower has no driver for it yet";
  if (!hostId) return "this workspace's host is gone";

  const here = agent.hosts.find((h) => h.hostId === hostId);
  if (!here?.installed) return `not installed on ${hostName ?? "that machine"}`;
  if (!agent.needsCredential) return undefined;
  if (here.loggedIn === true || agent.credentialSet) return undefined;
  return "no credentials for it there";
}

/** One row per agent, with the reason it cannot be started where there is one. */
export function useAgentChoices() {
  // The session you are in *is* the workspace: a workspace takes the id of the
  // session it was split from, and that is what the tab set is keyed by. So the
  // id is known without waiting for anything.
  const workspaceId = useCurrentSession() ?? undefined;
  const { data: session } = useGetSession(workspaceId ?? "", {
    query: { enabled: !!workspaceId },
  });
  const { data: agents = [], isPending, isError, refetch } = useListAgents();
  const { data: hosts = [] } = useListHosts();

  // Only needed to say *why* one is unavailable. Absent while it loads, which
  // reads as "we cannot tell yet" rather than hiding the row.
  const host = hosts.find((h) => h.id === session?.hostId);

  return {
    workspaceId,
    isPending,
    isError,
    refetch,
    choices: agents.map((agent) => ({
      agent,
      why: session ? unavailable(agent, host?.id, host?.name) : undefined,
    })),
  };
}

/**
 * Create the run, then hand back its id so the caller can show it.
 *
 * Awaited per call rather than answered in a mutation callback. Each agent is
 * an independent run and several may be starting at once; one observer's
 * `onSuccess` fires for the newest call, so starting three quickly meant the
 * first two were created and never shown — which looked like a cap on how many
 * a workspace takes.
 */
export function useStartAgent() {
  const start = useCreateSession();
  const cache = useQueryClient();

  return async (workspaceId: string, agent: AgentView["kind"]): Promise<string> => {
    const made = await start.mutateAsync({ data: { workspaceId, agent } });
    cache.invalidateQueries({ queryKey: getListSessionsQueryKey() });
    return made.id;
  };
}
