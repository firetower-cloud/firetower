import { describe, expect, it } from "vitest";
import {
  machines,
  machineKey,
  machineLabel,
  environmentLabel,
  parseDestination,
} from "./environments";
import type { Host } from "./generated/model";

const host = (id: string, compute: Host["compute"], extra: Partial<Host> = {}): Host => ({
  id,
  name: id,
  compute,
  state: "Online",
  path: "d/shared/localhost",
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
   * The machine Firetower ran agents on inside its own container. It is
   * retired: `listHosts` does not return it, so no picker can draw it — and
   * if one ever arrives, it is keyed on its own rather than folded in with a
   * real machine.
   */
  it("keeps a retired machine out of every other machine's group", () => {
    const retired = host("localhost", { type: "Local" });
    const real = host("the-vm", { ...ssh(), host: "control-vm" });
    const groups = machines([retired, real]);
    expect(groups.map((m) => m.key)).toEqual(["retired:localhost", "ssh:control-vm:22"]);
  });

  it("calls a machine what it is called, whatever kind it is", () => {
    const groups = machines([host("localhost", { type: "Local" })]);
    expect(groups[0].label).toBe("localhost");
    expect(environmentLabel(groups[0].hosts[0])).toBe("localhost");
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
