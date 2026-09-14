import { describe, expect, it } from "vitest";
import {
  machines,
  machineKey,
  machineLabel,
  executionOf,
  environmentLabel,
  isLocal,
  modesOn,
  environmentsOn,
  connectionOf,
  parseDestination,
} from "./environments";
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

describe("which machine an environment is on", () => {
  it("gives a remote machine both ways of running under one entry", () => {
    const groups = machines([host("remote-container", ssh("worker")), host("remote-native", ssh())]);
    expect(groups).toHaveLength(1);
    expect(modesOn(groups[0])).toEqual(["container", "host"]);
  });

  it("keeps machines on different SSH ports distinct", () => {
    expect(machines([host("one", ssh()), host("two", { ...ssh(), port: 2222 })])).toHaveLength(2);
  });

  /**
   * The change this whole screen turns on. An ssh connection to the machine
   * underneath used to be folded into `local`, which gave "this server" a
   * second mode — and choosing it asked Firetower to ssh to the machine it is
   * already sitting on.
   */
  it("does not fold an ssh connection into the machine hosting Firetower", () => {
    const local = host("local-container", { type: "Local" }, { execution: "container" });
    const underneath = host(
      "the-vm",
      { ...ssh(), host: "control-vm" },
      // Flagged same-machine when it was added, which used to be enough.
      { machine: "local" },
    );
    const groups = machines([local, underneath]);
    expect(groups.map((m) => m.key)).toEqual(["local", "ssh:control-vm:22"]);
    expect(modesOn(groups[0])).toEqual(["container"]);
  });

  it("leaves the machine hosting Firetower with exactly one way of running", () => {
    const groups = machines([host("local", { type: "Local" }, { execution: "host" })]);
    expect(isLocal(groups[0])).toBe(true);
    expect(modesOn(groups[0])).toEqual(["host"]);
    expect(environmentLabel(groups[0].hosts[0])).toBe("Firetower host process");
  });

  it("calls a machine what you call it, and says where it is beside that", () => {
    const [machine] = machines([host("build-box", { ...ssh(), host: "10.0.4.7", user: "editor" })]);
    expect(machine.label).toBe("build-box");
    expect(machineLabel(machine)).toBe("build-box · editor@10.0.4.7");
  });

  it("does not say the address twice when that is all it is called", () => {
    const [machine] = machines([host("10.0.4.7", { type: "Server", host: "10.0.4.7", key: { type: "Managed" } })]);
    expect(machineLabel(machine)).toBe("10.0.4.7");
  });

  it("does not claim a legacy local process runs on the underlying VM", () => {
    const legacy = host("localhost", { type: "Local" });
    expect(executionOf(legacy)).toBeUndefined();
    expect(environmentLabel(legacy)).toBe("Firetower process");
  });

  it("groups a container Firetower started on its own", () => {
    expect(machineKey(host("c", { type: "Container", name: "worker-1", image: "ft" })))
      .toBe("container:worker-1");
  });
});

describe("the second mode on a machine", () => {
  it("borrows the connection rather than asking for the address again", () => {
    const [machine] = machines([host("remote-native", { ...ssh(), user: "editor", port: 2222 })]);
    expect(connectionOf(machine)).toMatchObject({ host: "video-vm", user: "editor", port: 2222 });
    expect(environmentsOn(machine, "container")).toEqual([]);
  });

  it("has nothing to borrow on the machine hosting Firetower, which never needs it", () => {
    const [machine] = machines([host("local", { type: "Local" }, { execution: "container" })]);
    expect(connectionOf(machine)).toBeUndefined();
  });
});

describe("an address with the account in it", () => {
  it("comes apart the way ssh takes it", () => {
    expect(parseDestination("editor@192.0.2.10:2222")).toEqual({
      user: "editor",
      host: "192.0.2.10",
      port: 2222,
    });
  });

  it("leaves the account to the ssh config when nobody said", () => {
    expect(parseDestination("build-box")).toEqual({
      user: undefined,
      host: "build-box",
      port: undefined,
    });
  });

  it("does not mistake the colons in an IPv6 address for a port", () => {
    expect(parseDestination("2001:db8::1").host).toBe("2001:db8::1");
  });

  it("ignores what is only whitespace", () => {
    expect(parseDestination("  root@fire-01  ")).toEqual({
      user: "root",
      host: "fire-01",
      port: undefined,
    });
  });
});
