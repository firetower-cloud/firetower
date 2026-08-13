"use client";

import { useListHosts } from "@/src/api/generated/hosts/hosts";
import { AddHost } from "@/components/AddHost";
import type { Host } from "@/src/api/generated/model";

export default function Compute() {
  const { data: hosts = [], isLoading, isError } = useListHosts();
  const online = hosts.filter((h) => h.state === "Online").length;

  return (
    <div className="max-w-[900px] px-8 pt-8 pb-24">
      <header className="mb-7">
        <div className="eyebrow">Compute</div>
        <h1 className="mt-2 text-[26px] font-semibold tracking-[-0.02em] text-bone">
          {isLoading ? "Looking…" : `${online} of ${hosts.length} online.`}
        </h1>
        <p className="mt-1.5 max-w-[52ch] text-[14px] text-dim">
          Every host runs the worker and is reached over a stream it never listens on.
          Nothing here needs an inbound port.
        </p>
      </header>

      {isError && (
        <p className="panel mb-4 px-4 py-3 text-[13px] text-brick">
          Couldn&apos;t reach the control plane. Is Firetower running?
        </p>
      )}

      <div className="flex flex-col gap-2.5">
        {hosts.map((h) => (
          <HostRow key={h.id} host={h} />
        ))}
        {!isLoading && hosts.length === 0 && !isError && (
          <p className="panel px-4 py-6 text-center text-[13px] text-mute">
            No hosts yet.
          </p>
        )}
      </div>

      <AddHost />
    </div>
  );
}

function HostRow({ host }: { host: Host }) {
  const draining = host.state === "Draining";
  const dot =
    host.state === "Online" ? "bg-sage" : draining ? "border border-mute" : "bg-brick";

  return (
    <div className="panel px-4 py-3.5">
      <div className="flex items-center gap-2.5">
        <span className={`h-2 w-2 rounded-full ${dot}`} />
        <span className="font-mono text-[13.5px] text-bone">{host.name}</span>
        <span className="text-[12.5px] text-mute">
          {host.sshTarget ?? "this machine"}
        </span>
        <span className="ml-auto font-mono text-[11px] text-mute">
          {host.workerVersion ? `worker ${host.workerVersion}` : host.state.toLowerCase()}
        </span>
      </div>

      {host.state === "Unreachable" ? (
        <p className="mt-3 border-t border-line pt-3 text-[12.5px] text-dim">
          Not responding. Its sessions stay visible — hiding them would make running
          work look as though it had disappeared.
        </p>
      ) : (
        <div className="mt-3 grid grid-cols-[1fr_1fr_auto] items-center gap-6">
          <Meter label="CPU" value={host.cpus ?? 0} unit="" />
          <Meter label="Memory" value={Math.round((host.memoryMb ?? 0) / 1024)} unit=" GB" />
          <span className="font-mono text-[11.5px] text-dim">
            {host.sshTarget ? "remote" : "local"}
          </span>
        </div>
      )}
    </div>
  );
}

function Meter({ label, value, unit }: { label: string; value: number; unit: string }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="eyebrow">{label}</span>
        <span className="font-mono text-[11px] text-dim">
          {value || "—"}
          {value ? unit : ""}
        </span>
      </div>
      <div className="h-[3px] overflow-hidden rounded-full bg-line">
        <span className="block h-full bg-slate" style={{ width: value ? "35%" : "0%" }} />
      </div>
    </div>
  );
}
