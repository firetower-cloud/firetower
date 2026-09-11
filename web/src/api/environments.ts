import type { Host, Execution } from "./generated/model";

export function executionOf(host: Host): Execution | undefined {
  if (host.execution) return host.execution;
  if (host.compute.type === "Container") return "container";
  if (host.compute.type === "Server") return host.compute.container ? "container" : "host";
  // Older servers cannot say whether their local process is in Docker.
  return undefined;
}

export function machineKey(host: Host): string {
  if (host.machine === "local" || host.compute.type !== "Server") return "local";
  return `ssh:${host.compute.host}:${host.compute.port ?? 22}`;
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

export function connectionLabel(host: Host): string {
  const c = host.compute;
  if (c.type === "Server")
    return `${c.user ? `${c.user}@` : ""}${c.host}${c.port ? `:${c.port}` : ""}`;
  return c.type === "Container" ? c.name : "Alongside the control plane";
}

export function machines(hosts: Host[]): { key: string; label: string; hosts: Host[] }[] {
  const result = new Map<string, { key: string; label: string; hosts: Host[] }>();
  for (const host of hosts) {
    const key = machineKey(host);
    let machine = result.get(key);
    if (!machine) {
      machine = {
        key,
        label:
          key === "local"
            ? "This server — alongside Firetower"
            : host.compute.type === "Server"
              ? host.compute.host
              : host.name,
        hosts: [],
      };
      result.set(key, machine);
    }
    machine.hosts.push(host);
  }
  return [...result.values()];
}
