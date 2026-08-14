"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListHosts,
  useDeleteHost,
  useDrainHost,
  getListHostsQueryKey,
} from "@/src/api/generated/hosts/hosts";
import { useListSessions } from "@/src/api/generated/sessions/sessions";
import { useListAgents } from "@/src/api/generated/agents/agents";
import type { Host } from "@/src/api/generated/model";
import { AddCompute } from "@/components/AddCompute";
import { ApiError } from "@/src/api/http";

/**
 * Where agents run.
 *
 * Three kinds, and they aren't a ladder: this machine is fastest and its
 * workspaces are directories you can open; a container here is Linux and
 * isolated; a server is what a real deployment looks like.
 */
export default function Compute() {
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const { data: hosts = [], isLoading, isError } = useListHosts();
  const { data: sessions = [] } = useListSessions();
  const { data: agents = [] } = useListAgents();

  const online = hosts.filter((h) => h.state === "Online").length;

  return (
    <div className="max-w-[900px] px-8 pt-8 pb-24">
      <header className="mb-7">
        <div className="eyebrow">Compute</div>
        <h1 className="mt-2 text-[26px] font-semibold tracking-[-0.02em] text-bone">
          {isLoading ? "Looking…" : `${online} of ${hosts.length} online.`}
        </h1>
        <p className="mt-1.5 max-w-[54ch] text-[14px] text-dim">
          Every host runs the same worker over a stream it never listens on — this
          machine, a container, or a server you own. Nothing here needs an inbound port.
        </p>
      </header>

      {isError && (
        <p className="panel mb-4 px-4 py-3 text-[13px] text-brick">
          Couldn&apos;t reach the control plane. Is Firetower running?
        </p>
      )}

      {problem && (
        <p className="mb-4 rounded-[6px] border border-ember/30 bg-ember/[0.05] px-3.5 py-2.5 text-[12.5px] text-bone">
          {problem}
        </p>
      )}

      <div className="flex flex-col gap-2.5">
        {hosts.map((h) => (
          <HostRow
            key={h.id}
            host={h}
            running={sessions.filter((s) => s.hostId === h.id && s.status !== "Ended").length}
            agents={agents
              .filter((a) => a.hosts.some((x) => x.hostId === h.id && x.installed))
              .map((a) => a.label)}
            onProblem={setProblem}
          />
        ))}
        {!isLoading && hosts.length === 0 && !isError && (
          <p className="panel px-4 py-6 text-center text-[13px] text-mute">
            Nowhere to run anything yet.
          </p>
        )}
      </div>

      <button
        onClick={() => setAdding(true)}
        className="mt-4 w-full rounded-[6px] border border-dashed border-line py-3 text-[13px] text-mute transition-colors hover:border-ember/40 hover:text-ember"
      >
        + Add compute
      </button>

      {adding && <AddCompute onClose={() => setAdding(false)} />}
    </div>
  );
}

function HostRow({
  host,
  running,
  agents,
  onProblem,
}: {
  host: Host;
  running: number;
  agents: string[];
  onProblem: (message: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const remove = useDeleteHost();
  const drain = useDrainHost();

  const refresh = () => queryClient.invalidateQueries({ queryKey: getListHostsQueryKey() });
  const failed = (e: unknown) =>
    onProblem(e instanceof ApiError ? e.message : "That didn't work.");

  const kind = host.compute.type;

  return (
    <div className="panel px-4 py-3.5">
      <div className="flex items-center gap-3">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            host.state === "Online" ? "bg-sage" : "border border-mute"
          }`}
        />
        <span className="font-mono text-[13.5px] text-bone">{host.name}</span>
        <span className="rounded-[4px] border border-line px-1.5 py-0.5 font-mono text-[10.5px] text-slate">
          {kind === "Local" ? "this machine" : kind.toLowerCase()}
        </span>

        {host.drained && (
          <span className="rounded-[4px] border border-ember/30 px-1.5 py-0.5 font-mono text-[10.5px] text-ember">
            draining
          </span>
        )}

        <span className="ml-auto font-mono text-[11px] text-mute">
          {running > 0 ? `${running} running` : "idle"}
        </span>

        {/* A toggle, not a one-way door: draining a host by accident and
            having no way back would make it unusable until someone edited the
            database. */}
        <button
          onClick={() =>
            drain.mutate(
              { id: host.id, data: { drained: !host.drained } },
              { onSuccess: refresh, onError: failed },
            )
          }
          className="text-[11.5px] text-mute transition-colors hover:text-ember"
        >
          {host.drained ? "Resume" : "Drain"}
        </button>
        {/* This machine is always here, so there is nothing to remove. */}
        {kind !== "Local" && (
          <button
            onClick={() => {
              onProblem(null);
              // Its finished sessions go too — they are a record of what a
              // worker reported, and the worker is what's being removed.
              if (!confirm(`Remove ${host.name}? Its session history goes with it.`)) return;
              remove.mutate({ id: host.id }, { onSuccess: refresh, onError: failed });
            }}
            className="text-[11.5px] text-mute transition-colors hover:text-ember"
          >
            Remove
          </button>
        )}
      </div>

      <div className="mt-3 grid grid-cols-[110px_1fr] items-center gap-x-3 gap-y-1.5 border-t border-line pt-3">
        <span className="eyebrow">Reached by</span>
        <code className="truncate font-mono text-[11.5px] text-dim">{reach(host)}</code>

        <span className="eyebrow">Worker</span>
        <span className="font-mono text-[11.5px] text-dim">
          {host.workerVersion ?? <span className="text-mute">not connected</span>}
          {host.cpus ? ` · ${host.cpus} CPU` : ""}
        </span>

        <span className="eyebrow">Agents</span>
        <span className="font-mono text-[11.5px] text-dim">
          {agents.length > 0 ? agents.join(", ") : <span className="text-mute">none installed</span>}
        </span>
      </div>
    </div>
  );
}

/** How the control plane talks to this host — the honest answer, not a guess. */
function reach(host: Host) {
  switch (host.compute.type) {
    case "Local":
      return "a child process, no network";
    case "Container":
      return `docker exec ${host.compute.name}`;
    case "Server":
      return `ssh ${host.compute.target}`;
  }
}
