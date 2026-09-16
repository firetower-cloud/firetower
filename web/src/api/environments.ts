import { listHosts } from "./generated/hosts/hosts";
import type { Host } from "./generated/model";

/**
 * Which machine this environment is on.
 *
 * Identity comes from the compute and nothing else. It used to fold an SSH
 * connection flagged `sameMachine` into `local`, so the machine hosting
 * Firetower could hold two rows — and picking the one the control plane is
 * not in meant asking Firetower to ssh to the machine it is already sitting
 * on. That is not a mode of "this server"; it is another machine that happens
 * to be underneath us, and it is chosen like any other.
 */
export function machineKey(host: Host): string {
  const compute = host.compute;
  if (compute.type === "Local") return "local";
  return `ssh:${compute.host}:${compute.port ?? 22}`;
}

/**
 * The word beside a machine's name.
 *
 * Three, not two: a machine ssh got into and found no worker on is not
 * unreachable — the key worked, the address is right — and saying it was sent
 * people to check the wrong thing. The diagnosis already knows which; this
 * only says it.
 */
export function stateLabel(host: Host): "Online" | "Draining" | "No worker" | "Unreachable" {
  if (host.drained || host.state === "Draining") return "Draining";
  if (host.state === "Online") return "Online";
  return reachedTheMachine(host) ? "No worker" : "Unreachable";
}

/** Whether the last attempt got onto the machine and failed only after that. */
export function reachedTheMachine(host: Host): boolean {
  return host.diagnosis?.cause === "WorkerMissing" || host.diagnosis?.cause === "ProtocolMismatch";
}

export function environmentLabel(host: Host): string {
  return host.compute.type === "Local" ? "This machine" : host.name;
}

export function connectionLabel(host: Host): string {
  const c = host.compute;
  if (c.type === "Server")
    return `${c.user ? `${c.user}@` : ""}${c.host}${c.port ? `:${c.port}` : ""}`;
  return "Alongside the control plane";
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

/** The machine hosting the control plane: agents run where the control plane runs. */
export function isLocal(machine: Machine | undefined): boolean {
  return machine?.key === "local";
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

/**
 * Wait for a machine to come up after its worker was installed.
 *
 * Installing returns when the binary is in place; the supervisor then
 * reconnects on its own task, and the row says Online a few seconds later.
 * Refreshing the instant the install returned showed the old diagnosis and a
 * "check again" that somebody had to press — so this watches the list until
 * the machine answers, or gives up after a while and lets the panel say what
 * it sees.
 */
export async function waitForOnline(id: string, seconds = 45): Promise<Host | undefined> {
  for (let i = 0; i < seconds; i++) {
    const hosts = await listHosts().catch(() => [] as Host[]);
    const host = hosts.find((h) => h.id === id);
    if (host?.state === "Online") return host;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return undefined;
}
