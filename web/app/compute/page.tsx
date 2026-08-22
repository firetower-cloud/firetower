"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListHosts,
  useDeleteHost,
  useDrainHost,
  useRenameHost,
  useConnectHost,
  getListHostsQueryKey,
} from "@/src/api/generated/hosts/hosts";
import { useListSessions } from "@/src/api/generated/sessions/sessions";
import { useListAgents } from "@/src/api/generated/agents/agents";
import type { Host, SshKey } from "@/src/api/generated/model";
import { SetUpHost, canBeSetUp } from "@/components/SetUpHost";
import { AddCompute } from "@/components/AddCompute";
import { holdsHost } from "@/src/api/view";
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
            running={sessions.filter((s) => s.hostId === h.id && holdsHost(s)).length}
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
  const rename = useRenameHost();

  const refresh = () => queryClient.invalidateQueries({ queryKey: getListHostsQueryKey() });
  const failed = (e: unknown) =>
    onProblem(e instanceof ApiError ? e.message : "That didn't work.");

  /** Whether the set-up panel is open for this host. */
  const [settingUp, setSettingUp] = useState(false);

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
        {/* The address beside the name, for a machine that has one. The name is
            what you call it; this is how you tell two of them apart at a
            glance without reading the line below. */}
        {host.compute.type === "Server" && (
          <span className="truncate font-mono text-[11px] text-mute">
            {host.compute.host}
          </span>
        )}
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
        {/* Names are typed by hand and are the only thing on most screens, so
            getting one wrong should not mean removing the host and adding it
            again. */}
        {kind !== "Local" && (
          <button
            onClick={() => {
              onProblem(null);
              const next = prompt(`Call ${host.name} what?`, host.name);
              if (!next || next.trim() === host.name) return;
              rename.mutate(
                { id: host.id, data: { name: next.trim() } },
                { onSuccess: refresh, onError: failed },
              );
            }}
            className="text-[11.5px] text-mute transition-colors hover:text-ember"
          >
            Rename
          </button>
        )}
        {/* This machine is always here, so there is nothing to remove. */}
        {kind !== "Local" && (
          <button
            onClick={() => {
              onProblem(null);
              if (!confirm(removalWarning(host, running))) return;
              // Anything still running was named in the warning above, so this
              // is already the answer to "and end them?".
              remove.mutate(
                { id: host.id, params: { force: running > 0 } },
                { onSuccess: refresh, onError: failed },
              );
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
        <span className="flex items-center gap-2.5 font-mono text-[11.5px] text-dim">
          {host.workerVersion ? (
            <>
              {host.workerVersion}
              {host.cpus ? ` · ${host.cpus} CPU` : ""}
            </>
          ) : (
            <span className="text-mute">
              {canBeSetUp(host) ? "not installed" : "not connected"}
            </span>
          )}

          {/* Reached, and not set up. One command away, so the way to it is a
              button rather than a paragraph somewhere else. */}
          {canBeSetUp(host) && (
            <button
              onClick={() => setSettingUp(true)}
              className="rounded-[4px] border border-line px-1.5 py-0.5 text-[11px] text-slate transition-colors hover:border-[#3a3631] hover:text-bone"
            >
              See instructions
            </button>
          )}
        </span>

        <span className="eyebrow">Agents</span>
        <span className="font-mono text-[11.5px] text-dim">
          {agents.length > 0 ? agents.join(", ") : <span className="text-mute">none installed</span>}
        </span>
      </div>

      {/* Until now this page showed a grey dot and "not connected" for a
          switched-off machine, a wrong address, a refused key and a rebooting
          box alike — while the reason sat on the object, rendered only by the
          launch screen. */}
      {host.state !== "Online" && host.diagnosis && (
        <Wrong host={host} onRetry={refresh} />
      )}

      {settingUp && <SetUpHost host={host} onClose={() => setSettingUp(false)} />}
    </div>
  );
}

/**
 * Why a host isn't answering, and the two things worth doing about it.
 *
 * Not styled as an error. Most of these are a machine that is off, or one
 * command away from working, and neither is anybody's mistake.
 */
function Wrong({ host, onRetry }: { host: Host; onRetry: () => void }) {
  const connect = useConnectHost();

  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="flex items-start gap-3">
        <p className="flex-1 text-[11.5px] leading-[1.5] text-mute">
          {host.diagnosis?.summary}
          {host.reconnecting && " Still trying."}
        </p>
        <button
          onClick={() => connect.mutate({ id: host.id }, { onSuccess: onRetry })}
          disabled={connect.isPending}
          className="shrink-0 rounded-[5px] border border-line px-2 py-1 text-[11.5px] text-dim transition-colors hover:border-[#3a3631] hover:text-text disabled:text-mute"
        >
          {connect.isPending ? "Trying…" : "Try now"}
        </button>
      </div>

      {/* The remedy for anything that has one and no panel of its own — a
          stopped Docker, a container that isn't running. */}
      {host.diagnosis?.remedy && !canBeSetUp(host) && (
        <pre className="mt-2 overflow-x-auto rounded-[4px] bg-black/25 px-3 py-2 font-mono text-[11px] leading-[1.6] text-bone">
          {host.diagnosis.remedy}
        </pre>
      )}
    </div>
  );
}

/**
 * Everything that goes, said once, before it goes.
 *
 * A host with work on it is a different decision from an idle one, so it is a
 * different sentence — not the same prompt followed by an error you then have
 * to confirm past.
 */
function removalWarning(host: Host, running: number) {
  const container = host.compute.type === "Container";
  const machine = container
    ? `Its container is stopped and removed, and its session history goes with it.`
    : `Its session history goes with it. The machine itself is left alone.`;

  if (running === 0) return `Remove ${host.name}? ${machine}`;

  return (
    `Remove ${host.name}? ${running} ${running === 1 ? "session is" : "sessions are"} ` +
    `still running there. They're ended first, and anything unpushed goes with them. ` +
    machine
  );
}

/**
 * How the control plane talks to this host — the honest answer, not a guess.
 *
 * The server case is assembled from the parts rather than stored as typed, so
 * this is the line that shows which key and which port a connection is really
 * using. That is the whole question when one of them is wrong.
 */
function keyFlag(key: SshKey | undefined) {
  switch (key?.type) {
    case "File":
      return `-i ${key.path}`;
    case "Managed":
      return "-i <firetower's key>";
    case "Held":
      return `-i <${key.name}>`;
    default:
      return null;
  }
}

function reach(host: Host) {
  switch (host.compute.type) {
    case "Local":
      return "a child process, no network";
    case "Container":
      return `docker exec ${host.compute.name}`;
    case "Server": {
      const { host: address, user, port, key } = host.compute;
      return [
        "ssh",
        port ? `-p ${port}` : null,
        // A path is shown as one. The two the vault holds have no path worth
        // showing — they are written where ssh can read them at the moment of
        // connecting and removed again — so they are named instead.
        keyFlag(key),
        user ? `${user}@${address}` : address,
      ]
        .filter(Boolean)
        .join(" ");
    }
  }
}
