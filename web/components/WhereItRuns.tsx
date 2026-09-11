"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCreateHost, getListHostsQueryKey } from "@/src/api/generated/hosts/hosts";
import type { Agent, AgentView, Execution, Host } from "@/src/api/generated/model";
import { AgentMark } from "@/components/AgentMark";
import { Readout } from "@/components/HostReadiness";
import {
  connectionOf,
  environmentLabel,
  executionFact,
  executionOf,
  isLocal,
  machineLabel,
  machines,
  modesOn,
  type Machine,
} from "@/src/api/environments";

/** The default container to look for, and the only one anybody has to type. */
export const WORKER_CONTAINER = "firetower-worker";

export type Where = {
  /** Which machine, by the key `machineKey` gives it. Empty means "not yet". */
  machine: string;
  execution: Execution;
  /**
   * Whether the mode above was chosen rather than defaulted to.
   *
   * Picking a mode a machine has never run is what makes its environment, so
   * the difference between choosing one and landing on one matters: without
   * this, opening the machine list and looking at a machine would quietly
   * create a worker connection on it.
   */
  picked?: boolean;
  /** Which environment on it, when the machine has more than one of that mode. */
  hostId: string;
  agent: Agent | "";
};

/**
 * Machine, mode, agent — and what that combination has to say for itself.
 *
 * ## Why these three are one control
 *
 * They were four: a machine, a `Run in` pair of radios, an `Environment`
 * select, and a button called *Set up an execution environment*. The reason
 * there were four is that a `Host` row is a machine and a mode fused together,
 * so picking a mode was really filtering a list of rows — and picking one with
 * no row behind it produced an empty list, a grey sentence, and a dead Create
 * button. The button then opened a dialog that asked for the machine and the
 * mode again, because a row needs both.
 *
 * Here a machine is a place and a mode is a mode. Both modes exist on every
 * machine, selectable before anything is configured; the row underneath is
 * made when it is picked. Nothing is set up in advance, so there is nothing to
 * press to set it up.
 *
 * The agent belongs here too. What decides whether an agent can start is the
 * three of them together, and the verdict at the bottom is about all three.
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
  const cache = useQueryClient();
  const create = useCreateHost();

  const all = machines(hosts);
  // Defaulted only while nothing has been chosen. A machine that was chosen and
  // has since gone is not a reason to run somewhere else — this form must never
  // quietly move a workspace to a different worker.
  const machine = where.machine ? all.find((m) => m.key === where.machine) : all[0];
  const local = isLocal(machine);

  // On the machine hosting Firetower the mode is not a choice: agents run
  // where the control plane runs, and the control plane has always known which
  // that is. Offering the other half meant offering to ssh to the machine we
  // are already sitting on.
  const onlyMode = local
    ? (machine?.hosts.map(executionOf).find(Boolean) ?? "container")
    : undefined;
  // Landing on a machine lands on Container unless that machine only runs on
  // the host. Container is the answer for almost everybody — the agent gets the
  // image's tools rather than whatever happens to be on someone's VM — and
  // `modesOn` returned whichever environment the list happened to hold first,
  // so which mode you landed on depended on row order.
  const execution = onlyMode ?? (where.picked ? where.execution : defaultMode(machine));

  const here = (machine?.hosts ?? []).filter((h) => executionOf(h) === execution);
  const host = where.hostId
    ? here.find((h) => h.id === where.hostId)
    : (here.find((h) => h.state === "Online") ?? here[0]);

  const runsHere = (a: AgentView) => (host ? canRun(a, host.id) : false);
  const choices = [...agents].sort((a, b) => Number(runsHere(b)) - Number(runsHere(a)));
  const agentKind = (where.agent || choices.find(runsHere)?.kind || choices[0]?.kind) as
    | Agent
    | undefined;
  const chosen = choices.find((c) => c.kind === agentKind);

  // The environment for a mode that has never been used on this machine.
  //
  // Made when it is chosen rather than in a form beforehand, because being
  // chosen is the only thing that ever made it wanted. Guarded by what was
  // already attempted, so a list that arrives a second time cannot ask for a
  // second copy of the same row.
  const asked = useRef(new Set<string>());
  const connection = connectionOf(machine);
  const missing = !!machine && !local && !!where.picked && here.length === 0 && !!connection;
  useEffect(() => {
    if (!missing || !machine || !connection) return;
    const key = `${machine.key}:${execution}`;
    if (asked.current.has(key)) return;
    asked.current.add(key);
    create.mutate(
      {
        data: {
          name: nameFor(hosts, connection.host, execution),
          compute: {
            ...connection,
            container: execution === "container" ? WORKER_CONTAINER : undefined,
          },
        },
      },
      {
        onSuccess: async (made) => {
          await cache.invalidateQueries({ queryKey: getListHostsQueryKey() });
          onChange({ ...where, machine: machine.key, execution, picked: true, hostId: made.id });
        },
      },
    );
    // `where` and `create` change on every render; the pair being set up is
    // what this is about.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missing, machine?.key, execution]);

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
                // A new machine, so the mode is whatever that one runs until
                // somebody says otherwise.
                onChange({ ...where, machine: e.target.value, hostId: "", picked: false });
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

          <Line label="Run in">
            {onlyMode ? (
              // A fact, in the row a choice would have been in, so the shape of
              // this block does not change from one machine to the next.
              <span className="flex flex-col gap-0.5">
                <span className="text-ui text-bone">{executionFact(onlyMode, true)}</span>
                <button
                  type="button"
                  onClick={onAddMachine}
                  className="self-start text-meta text-slate hover:text-bone"
                >
                  {onlyMode === "container"
                    ? "Need the host underneath? Add it as a machine →"
                    : "A container here? Add it as a machine →"}
                </button>
              </span>
            ) : (
              <span className="flex gap-1.5">
                {(["container", "host"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={execution === mode}
                    onClick={() => onChange({ ...where, execution: mode, picked: true, hostId: "" })}
                    className={`rounded-md border px-3 py-1.5 text-ui transition-colors ${
                      execution === mode
                        ? "border-mute/60 bg-overlay text-bone"
                        : "border-line text-dim hover:border-mute/60 hover:text-bone"
                    }`}
                  >
                    {mode === "container" ? "Container" : "Directly on host"}
                  </button>
                ))}
              </span>
            )}
          </Line>

          {/* Only when this machine really has two of the same mode. It used to
              be on screen every time, usually with one option in it. */}
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
          ) : create.isError ? (
            <p role="alert" className="px-3 py-2.5 text-meta text-brick">
              {(create.error as { message?: string }).message}
            </p>
          ) : (
            <p role="status" className="px-3 py-2.5 text-meta text-dim">
              {missing || create.isPending
                ? "Setting this up…"
                : "Nowhere to run anything yet. Add a machine."}
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
 * Authentication is per host, not global: a subscription lives in the agent's
 * own config on the machine it was signed in on, so one host being logged in
 * says nothing about another. Only a token we hold travels.
 */
export function canRun(agent: AgentView, hostId: string) {
  const here = agent.hosts.find((h) => h.hostId === hostId);
  if (!here?.installed) return false;
  if (!agent.needsCredential) return true;
  return here.loggedIn === true || agent.credentialSet;
}

/**
 * Marked rather than hidden: disappearing from a list looks like the thing does
 * not exist, and leaves nowhere to learn what is missing.
 */
function label(agent: AgentView, runsHere: boolean) {
  return runsHere ? agent.label : `${agent.label} · not installed there`;
}

/**
 * What to call an environment nobody will ever name.
 *
 * These are made by choosing a mode, not by filling in a form, so there is no
 * one to ask — and the server refuses a name another host already has. Built
 * from the address rather than from a sibling environment's name, because a
 * machine whose first environment is called `video-vm · container` would
 * otherwise have its second one called that too.
 */
export function nameFor(hosts: Host[], address: string, execution: Execution): string {
  const taken = new Set(hosts.map((h) => h.name));
  const base = execution === "container" ? `${address} · container` : address;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
  }
}

/**
 * The mode a machine opens on, before anybody picks.
 *
 * Container, unless the machine has a host environment and no container one.
 * A machine with neither is new, and a new machine's first environment should
 * be a container too.
 */
export function defaultMode(machine: Machine | undefined): Execution {
  const modes = modesOn(machine);
  return modes.length === 1 && modes[0] === "host" ? "host" : "container";
}

/** Which environment the form would actually use, for the caller's own checks. */
export function resolve(hosts: Host[], where: Where): { machine?: Machine; host?: Host } {
  const all = machines(hosts);
  const machine = where.machine ? all.find((m) => m.key === where.machine) : all[0];
  const modes = modesOn(machine);
  const execution = isLocal(machine)
    ? (modes[0] ?? where.execution)
    : where.picked
      ? where.execution
      : defaultMode(machine);
  const here = (machine?.hosts ?? []).filter((h) => executionOf(h) === execution);
  return {
    machine,
    host: where.hostId
      ? here.find((h) => h.id === where.hostId)
      : (here.find((h) => h.state === "Online") ?? here[0]),
  };
}
