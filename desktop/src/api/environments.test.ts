import { describe, expect, it } from "vitest";
import {
  machines,
  machineKey,
  machineLabel,
  environmentLabel,
  isLocal,
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
const ssh = (): Extract<Host["compute"], { type: "Server" }> => ({
  type: "Server",
  host: "video-vm",
  key: { type: "Managed" },
});

describe("which machine an environment is on", () => {
  it("groups rows that reach the same address and port", () => {
    const groups = machines([host("editor", { ...ssh(), user: "editor" }), host("root", { ...ssh(), user: "root" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].hosts).toHaveLength(2);
  });

  it("keeps machines on different SSH ports distinct", () => {
    expect(machines([host("one", ssh()), host("two", { ...ssh(), port: 2222 })])).toHaveLength(2);
  });

  /**
   * An ssh connection to the machine underneath used to be folded into
   * `local`, which gave "this server" a second mode — and choosing it asked
   * Firetower to ssh to the machine it is already sitting on.
   */
  it("does not fold an ssh connection into the machine hosting Firetower", () => {
    const local = host("local", { type: "Local" });
    const underneath = host(
      "the-vm",
      { ...ssh(), host: "control-vm" },
      // Flagged same-machine when it was added, which used to be enough.
      { machine: "local" },
    );
    const groups = machines([local, underneath]);
    expect(groups.map((m) => m.key)).toEqual(["local", "ssh:control-vm:22"]);
  });

  it("knows the machine hosting Firetower", () => {
    const groups = machines([host("local", { type: "Local" })]);
    expect(isLocal(groups[0])).toBe(true);
    expect(environmentLabel(groups[0].hosts[0])).toBe("This machine");
    expect(machineKey(groups[0].hosts[0])).toBe("local");
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
