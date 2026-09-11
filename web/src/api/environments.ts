import type { Host, Execution } from "./generated/model";

export function executionOf(host: Host): Execution | undefined {
  if (host.execution) return host.execution;
  if (host.compute.type === "Container") return "container";
  if (host.compute.type === "Server") return host.compute.container ? "container" : "host";
  // Older servers cannot say whether their local process is in Docker.
  return undefined;
}

/**
 * Which machine this environment is on.
 *
 * Identity comes from the compute and nothing else. It used to fold an SSH
 * connection flagged `sameMachine` into `local`, so the machine hosting
 * Firetower could hold two execution modes — and picking the one the control
 * plane is not in meant asking Firetower to ssh to the machine it is already
 * sitting on. That is not a mode of "this server"; it is another machine that
 * happens to be underneath us, and it is chosen like any other.
 */
export function machineKey(host: Host): string {
  const compute = host.compute;
  if (compute.type === "Local") return "local";
  if (compute.type === "Container") return `container:${compute.name}`;
  return `ssh:${compute.host}:${compute.port ?? 22}`;
}

export function environmentLabel(host: Host): string {
  const execution = executionOf(host);
  if (host.compute.type === "Local") {
    return execution === "container"
      ? "Firetower container"
      : execution === "host"
        ? "Firetower host process"
        : "Firetower process";
  }
  return host.name;
}

export function executionLabel(host: Host): string {
  return executionOf(host) === "container"
    ? "Container"
    : executionOf(host) === "host"
      ? "Directly on host"
      : "Execution unknown";
}

/** What "Run in" says when it is a fact rather than a choice. */
export function executionFact(execution: Execution | undefined, local: boolean): string {
  if (execution === "container") return local ? "the Firetower container" : "a container";
  if (execution === "host") return local ? "this machine, as the Firetower account" : "the machine itself";
  return "the Firetower process";
}

export function connectionLabel(host: Host): string {
  const c = host.compute;
  if (c.type === "Server")
    return `${c.user ? `${c.user}@` : ""}${c.host}${c.port ? `:${c.port}` : ""}`;
  return c.type === "Container" ? c.name : "Alongside the control plane";
}

export type Machine = {
  key: string;
  /** What you call it. */
  label: string;
  /** Where it is, when that is a different thing from what you call it. */
  address?: string;
  hosts: Host[];
};

export function machines(hosts: Host[]): Machine[] {
  const result = new Map<string, Machine>();
  for (const host of hosts) {
    const key = machineKey(host);
    let machine = result.get(key);
    if (!machine) {
      machine = {
        key,
        label:
          key === "local"
            ? "This server — alongside Firetower"
            : // What you call it, never where it is: a list of addresses is a
              // list nobody can read. `create_host` fills the name in from the
              // address when the form left it blank, so there is always one.
              host.name,
        address: host.compute.type === "Server" ? connectionLabel(host) : undefined,
        hosts: [],
      };
      result.set(key, machine);
    }
    machine.hosts.push(host);
  }
  return [...result.values()];
}

/** How a machine is named in a list: what you call it, and where it is. */
export function machineLabel(machine: Machine): string {
  return machine.address && machine.address !== machine.label
    ? `${machine.label} · ${machine.address}`
    : machine.label;
}

/**
 * The machine hosting the control plane runs agents exactly where the control
 * plane runs: in its container, or on the machine. There is no second answer to
 * offer, and offering one was inventing a choice the system does not have.
 */
export function isLocal(machine: Machine | undefined): boolean {
  return machine?.key === "local";
}

/** The execution modes this machine already has an environment for. */
export function modesOn(machine: Machine | undefined): Execution[] {
  const modes = new Set<Execution>();
  for (const host of machine?.hosts ?? []) {
    const execution = executionOf(host);
    if (execution) modes.add(execution);
  }
  return [...modes];
}

export function environmentsOn(machine: Machine | undefined, execution: Execution): Host[] {
  return (machine?.hosts ?? []).filter((h) => executionOf(h) === execution);
}

/**
 * How to reach this machine, borrowed from an environment already on it.
 *
 * A machine's second mode is the same connection with a different far end, so
 * nobody should be asked for the address a second time. Returns undefined for a
 * machine there is no ssh connection to — the local one — which is also the one
 * that never needs a second mode.
 */
export function connectionOf(
  machine: Machine | undefined,
): Extract<Host["compute"], { type: "Server" }> | undefined {
  for (const host of machine?.hosts ?? []) {
    if (host.compute.type === "Server") return host.compute;
  }
  return undefined;
}

/**
 * `user@host:port`, split the way the server splits it.
 *
 * Mirrors `ft_core::parse_destination`, and only so the form can say what the
 * machine will be called before it is added. The server parses it again and its
 * answer is the one that is stored — which is why the rules here are copied
 * rather than improved on.
 */
export function parseDestination(input: string): { user?: string; host: string; port?: number } {
  let text = input.trim();
  // The same thing written as a URL, which is how a provider's console tends to
  // offer it.
  if (text.startsWith("ssh://")) text = text.slice("ssh://".length);

  const at = text.indexOf("@");
  const user = at > 0 && at < text.length - 1 ? text.slice(0, at) : undefined;
  const rest = user === undefined ? text : text.slice(at + 1);

  // `[::1]:2222` is the one unambiguous way to write an address and a port
  // together, so it is the one place brackets mean anything.
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close !== -1) {
      const port = Number(rest.slice(close + 2));
      return {
        user,
        host: rest.slice(1, close),
        port: rest[close + 1] === ":" && Number.isInteger(port) ? port : undefined,
      };
    }
  }

  // Elsewhere a colon is only a port when there is exactly one of them. An IPv6
  // address written bare has several, and splitting on the first would quietly
  // hand back a truncated address.
  const colon = rest.indexOf(":");
  if (colon !== -1 && !rest.slice(colon + 1).includes(":")) {
    const port = Number(rest.slice(colon + 1));
    if (Number.isInteger(port) && port > 0 && port < 65536) {
      return { user, host: rest.slice(0, colon), port };
    }
  }
  return { user, host: rest, port: undefined };
}
