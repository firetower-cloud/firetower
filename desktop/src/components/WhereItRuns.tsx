"use client";

import { Monitor } from "lucide-react";
import type { Agent, AgentView, Host } from "~/api/generated/model";
import { useSessions } from "~/data";
import { AgentMark } from "~/components/AgentMark";
import { Readout } from "~/components/HostReadiness";
import {
  environmentLabel,
  machineLabel,
  machines,
  type Machine,
} from "~/api/environments";

export type Where = {
  /** Which machine, by the key `machineKey` gives it. Empty means "not yet". */
  machine: string;
  /** Which environment on it, when the machine has more than one. */
  hostId: string;
  agent: Agent | "";
};

/**
 * Machine, agent — and what that combination has to say for itself.
 *
 * A machine is a place, and agents run on it directly: there is no mode to
 * pick. The agent belongs here because what decides whether an agent can
 * start is the two of them together, and the verdict at the bottom is about
 * both.
 */
export function WhereItRuns({
  hosts,
  agents,
  where,
  onChange,
  onAddMachine,
}: {
  hosts: Host[];
  agents: AgentView[];
  where: Where;
  onChange: (where: Where) => void;
  onAddMachine: () => void;
}) {
  const all = machines(hosts);

  // Nothing to choose between, so nothing that looks like a choice. A select
  // whose only entry is "+ Add a machine…" is a control that looks like a
  // picker and is not one, with the action buried inside it.
  if (all.length === 0) {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-meta font-medium text-dim">Where it runs</span>
        <div className="overflow-hidden rounded-md border border-line bg-raise">
          <NoMachine onAddMachine={onAddMachine} />
        </div>
      </div>
    );
  }

  // Defaulted only while nothing has been chosen. A machine that was chosen and
  // has since gone is not a reason to run somewhere else — this form must never
  // quietly move a workspace to a different worker.
  const machine = where.machine ? all.find((m) => m.key === where.machine) : all[0];

  const here = machine?.hosts ?? [];
  const host = where.hostId
    ? here.find((h) => h.id === where.hostId)
    : (here.find((h) => h.state === "Online") ?? here[0]);

  const runsHere = (a: AgentView) => (host ? canRun(a, host.id) : false);
  const choices = [...agents].sort((a, b) => Number(runsHere(b)) - Number(runsHere(a)));
  const agentKind = (where.agent || choices.find(runsHere)?.kind || choices[0]?.kind) as
    | Agent
    | undefined;
  const chosen = choices.find((c) => c.kind === agentKind);

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-meta font-medium text-dim">Where it runs</span>
      <div className="overflow-hidden rounded-md border border-line bg-raise">
        <div className="flex flex-col gap-2.5 p-3">
          <Line label="Machine">
            <select
              aria-label="Machine"
              value={machine?.key ?? ""}
              onChange={(e) => {
                if (e.target.value === "+") return onAddMachine();
                onChange({ ...where, machine: e.target.value, hostId: "" });
              }}
              className="w-full rounded-md border border-line bg-ground px-3 py-2 text-ui text-bone"
            >
              {!machine && <option value="">Choose a machine</option>}
              {all.map((m) => (
                <option key={m.key} value={m.key}>
                  {machineLabel(m)}
                </option>
              ))}
              <option value="+">+ Add a machine…</option>
            </select>
          </Line>

          {/* Only when this machine really has two rows — the same address
              reached as two accounts. It used to be on screen every time,
              usually with one option in it. */}
          {here.length > 1 && (
            <Line label="Which one">
              <select
                aria-label="Which one"
                value={host?.id ?? ""}
                onChange={(e) => onChange({ ...where, hostId: e.target.value })}
                className="w-full rounded-md border border-line bg-ground px-3 py-2 text-ui text-bone"
              >
                {here.map((h) => (
                  <option key={h.id} value={h.id}>
                    {environmentLabel(h)}
                    {h.state !== "Online" ? " — unreachable" : ""}
                  </option>
                ))}
              </select>
            </Line>
          )}

          <Line label="Agent">
            <span className="relative flex items-center gap-2 rounded-md border border-line bg-ground px-3 py-2">
              {agentKind && (
                <span className="shrink-0 text-mute">
                  <AgentMark agent={agentKind} size={13} />
                </span>
              )}
              <span className="min-w-0 flex-1 truncate text-ui text-bone">
                {chosen ? label(chosen, runsHere(chosen)) : "no agent"}
              </span>
              <span aria-hidden className="shrink-0 text-micro text-mute">
                ▾
              </span>
              <select
                aria-label="Agent"
                value={agentKind ?? ""}
                onChange={(e) => onChange({ ...where, agent: e.target.value as Agent })}
                className="absolute inset-0 cursor-pointer opacity-0"
              >
                {choices.length === 0 && <option value="">no agent</option>}
                {choices.map((c) => (
                  <option key={c.kind} value={c.kind}>
                    {label(c, runsHere(c))}
                  </option>
                ))}
              </select>
            </span>
          </Line>
        </div>

        <div className="border-t border-line">
          {host ? (
            <Readout key={`${host.id}:${agentKind}`} host={host} agent={agentKind} agentLabel={chosen?.label} />
          ) : (
            <p role="status" className="px-3 py-2.5 text-meta text-dim">
              That machine is no longer here. Choose another.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * No machine to run on — one block, used by all three forms that ask.
 *
 * The three disagreed: a verdict strip here, "No machine is connected" as a
 * non-choice inside `NewWorkspace`'s select, and "No machine connected." with
 * no way out in `NewPage`'s menu. That was survivable while Firetower
 * registered its own container as a machine and the state was unreachable. It
 * is what every fresh install opens on now, so there is one of it, and it
 * carries the one thing to do.
 */
export function NoMachine({ onAddMachine }: { onAddMachine: () => void }) {
  return (
    <div className="px-3 py-3">
      <p className="text-ui text-bone">No machine to run on</p>
      <p className="mt-1 max-w-[46ch] text-meta text-dim">
        Agents run on a machine you add over ssh. Firetower does not run them on itself.
      </p>
      <button
        onClick={onAddMachine}
        className="control mt-2.5 border border-line bg-panel text-ui text-bone hover:bg-overlay"
      >
        Add a machine
      </button>
    </div>
  );
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] items-start gap-3">
      <span className="pt-2 text-meta text-dim">{label}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/**
 * Whether this agent can start on that environment.
 *
 * Installed there, and with an account connected here. The machine's own
 * sign-in does not count: a session runs on a named account, so that what it
 * spends is known and can be switched away from.
 */
/* ── What used to be along the bottom edge ─────────────────────────────
   `ui/StatusBar.tsx` kept the branch, the machine and the elapsed time in one
   line of mono across the foot of every workspace. It is gone: a strip of
   chrome that is always there is a strip nobody reads, and the three facts on
   it are not the same kind of fact. The branch and the age are now sentences
   at the top of the right rail's Overview, where the rest of what this
   workspace *is* already lives. The machine's own detail is below, which is
   the half that genuinely needed a card rather than a line. */

/** Where a session runs, as words. The Mac is a client; "Firetower's machine" is the one underneath the control plane. */
export function whereItRuns(host: Host | undefined, hosts: Host[]) {
  if (!host) return null;
  const machine = machines(hosts).find((m) => m.hosts.some((h) => h.id === host.id));
  return {
    /* **No "Firetower's machine" any more.** `Compute::Local` named the
       control plane's own container and main retired it — `listHosts` never
       returns one, so the branch could only ever have been dead weight. A
       machine is one somebody added, and it has a name. */
    name: machine?.label ?? host.name,
    how: "on the machine",
    Mark: Monitor,
    quiet: host.state === "Unreachable" || !!host.reconnecting,
    draining: host.state === "Draining" || !!host.drained,
  };
}


const gb = (mb?: number | null) => (mb ? `${Math.round(mb / 1024)} GB` : null);

/** The facts that do not fit a line. Anchored above the bar, or at a point on screen when told one. */
export function HostCard({ host, where, at }: { host: Host; where: NonNullable<ReturnType<typeof whereItRuns>>; at?: { x: number; y: number } }) {
  const sessions = useSessions();
  const on = sessions.data.filter((s) => s.hostId === host.id && s.status !== "Ended").length;
  const docker = host.docker?.status === "Running" ? `Docker ${host.docker.detail ?? ""}`.trim() : host.docker?.status === "Absent" ? "no Docker" : host.docker?.status === "Stopped" ? "Docker stopped" : null;
  return (
    <div
      style={at ? { left: Math.min(at.x, window.innerWidth - 22 * 16 - 12), top: at.y + 8 } : undefined}
      className={`${at ? "fixed" : "absolute bottom-7 left-3"} z-40 w-[22rem] rounded-xl border border-line lift px-4 py-3 font-sans text-left shadow-(--shadow-float)`}
    >
      <div className="flex items-center gap-2">
        <where.Mark className="h-3.5 w-3.5 text-slate" strokeWidth={1.75} />
        <span className="text-ui text-bone">{where.name}</span>
        <span className={`ml-auto text-micro ${host.state === "Online" ? "text-sage" : host.state === "Draining" ? "text-dim" : "text-brick"}`}>{host.state === "Unreachable" ? "Not answering" : host.state}</span>
      </div>
      <p className="mt-1.5 text-meta text-dim">
        {where.how[0].toUpperCase() + where.how.slice(1)}
        {docker ? ` · ${docker}` : ""}
      </p>
      <p className="text-meta text-dim">
        {[host.cpus ? `${host.cpus} cores` : null, gb(host.memoryMb), `${on} session${on === 1 ? "" : "s"} on it`].filter(Boolean).join(" · ")}
      </p>
      <p className="text-meta text-mute">{host.workerVersion ? `worker ${host.workerVersion}` : "worker version unknown"}</p>
    </div>
  );
}

export function canRun(agent: AgentView, hostId: string) {
  const here = agent.hosts.find((h) => h.hostId === hostId);
  if (!here?.installed) return false;
  if (!agent.needsCredential) return true;
  return agent.credentialSet;
}

/**
 * Marked rather than hidden: disappearing from a list looks like the thing does
 * not exist, and leaves nowhere to learn what is missing.
 */
function label(agent: AgentView, runsHere: boolean) {
  return runsHere ? agent.label : `${agent.label} · not installed there`;
}

/** Which environment the form would actually use, for the caller's own checks. */
export function resolve(hosts: Host[], where: Where): { machine?: Machine; host?: Host } {
  const all = machines(hosts);
  const machine = where.machine ? all.find((m) => m.key === where.machine) : all[0];
  const here = machine?.hosts ?? [];
  return {
    machine,
    host: where.hostId
      ? here.find((h) => h.id === where.hostId)
      : (here.find((h) => h.state === "Online") ?? here[0]),
  };
}
