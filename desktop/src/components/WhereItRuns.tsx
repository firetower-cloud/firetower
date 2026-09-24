"use client";

import type { Agent, AgentView, Host } from "~/api/generated/model";
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
              Nowhere to run anything yet. Add a machine.
            </p>
          )}
        </div>
      </div>
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
export function canRun(agent: AgentView, hostId: string) {
  const here = agent.hosts.find((h) => h.hostId === hostId);
  if (!here?.installed) return false;
  if (agent.kind === "KimiCode" || !agent.needsCredential) return true;
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
