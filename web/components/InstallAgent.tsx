"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  useInstallAgent,
  getListAgentsQueryKey,
} from "@/src/api/generated/agents/agents";
import type { AgentView, AgentOnHost } from "@/src/api/generated/model";
import { ApiError } from "@/src/api/http";

/**
 * Put an agent on one host.
 *
 * The alternative was a shell command on the machine itself — fine for a
 * server somebody is already logged in to, and useless for the container
 * Firetower is running inside, which is the one host everybody has.
 *
 * npm takes the best part of a minute, so the button says so and stays put.
 * Nothing is lost if the page is reloaded while it runs: the install is
 * happening on the host, and the next look at the list finds it.
 */
export function Install({
  agent,
  host,
}: {
  agent: AgentView;
  host: AgentOnHost;
}) {
  const queryClient = useQueryClient();
  const install = useInstallAgent();

  const go = () =>
    install.mutate(
      { kind: agent.kind, data: { hostId: host.hostId } },
      {
        // The answer is the whole list, freshly probed — so the row this
        // button is in redraws from it rather than from a second request.
        onSuccess: (agents) =>
          queryClient.setQueryData(getListAgentsQueryKey(), agents),
      },
    );

  return (
    <>
      <button
        onClick={go}
        disabled={install.isPending}
        className="shrink-0 text-meta text-mute transition-colors hover:text-bone disabled:hover:text-mute"
      >
        {install.isPending ? "Installing…" : "Install"}
      </button>
      {install.isError && (
        <span className="min-w-0 truncate text-meta text-brick">
          {install.error instanceof ApiError
            ? install.error.message
            : "it didn't install"}
        </span>
      )}
    </>
  );
}
