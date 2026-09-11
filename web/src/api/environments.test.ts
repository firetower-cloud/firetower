import { describe, expect, it } from "vitest";
import { machines, executionOf, environmentLabel } from "./environments";
import type { Host } from "./generated/model";

const host = (id: string, compute: Host["compute"], extra: Partial<Host> = {}): Host => ({
  id,
  name: id,
  compute,
  state: "Online",
  drained: false,
  reconnecting: false,
  docker: { status: "Unknown" },
  ...extra,
});
const ssh = (container?: string): Extract<Host["compute"], { type: "Server" }> => ({
  type: "Server",
  host: "video-vm",
  key: { type: "Managed" },
  container,
});

describe("execution environments", () => {
  it("groups both execution choices on both local and remote machines", () => {
    const local = host("local-container", { type: "Local" }, { execution: "container" });
    const localNative = host(
      "local-native",
      { ...ssh(), host: "control-vm" },
      { machine: "local" },
    );
    const remoteContainer = host("remote-container", ssh("worker"));
    const remoteNative = host("remote-native", ssh());
    const groups = machines([local, localNative, remoteContainer, remoteNative]);
    expect(groups.map((m) => m.hosts.map(executionOf))).toEqual([
      ["container", "host"],
      ["container", "host"],
    ]);
    expect(groups[0].key).toBe("local");
    expect(groups[1].label).toBe("video-vm");
    expect(environmentLabel(local)).toBe("Firetower container");
  });
  it("does not claim a legacy local process runs on the underlying VM", () => {
    const legacy = host("localhost", { type: "Local" });
    expect(executionOf(legacy)).toBeUndefined();
    expect(environmentLabel(legacy)).toBe("Firetower process");
  });
  it("keeps machines on different SSH ports distinct", () => {
    expect(machines([host("one", ssh()), host("two", { ...ssh(), port: 2222 })])).toHaveLength(2);
  });
});
