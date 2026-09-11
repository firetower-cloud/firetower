import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WhereItRuns, nameFor, defaultMode, type Where } from "./WhereItRuns";
import { getHostReadinessQueryKey } from "@/src/api/generated/hosts/hosts";
import type { AgentView, Host, Readiness } from "@/src/api/generated/model";
import { machines } from "@/src/api/environments";

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
const ssh = (container?: string, at = "video-vm"): Host["compute"] => ({
  type: "Server",
  host: at,
  key: { type: "Managed" },
  container,
});
const claude: AgentView = {
  kind: "ClaudeCode",
  label: "Claude Code",
  hosts: [],
  needsCredential: false,
  credentialSet: true,
  supported: true,
  enabled: true,
  signsInWithACode: false,
};

const where = (over: Partial<Where> = {}): Where => ({
  machine: "",
  execution: "container",
  hostId: "",
  agent: "",
  ...over,
});

/** Rendered with a cache that answers, so nothing is left mid-flight. */
function draw(hosts: Host[], w: Where, readiness?: Readiness) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false } },
  });
  if (readiness) {
    for (const h of hosts) {
      cache.setQueryData(getHostReadinessQueryKey(h.id, { agent: "ClaudeCode" }), readiness);
      cache.setQueryData(getHostReadinessQueryKey(h.id, {}), readiness);
    }
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <WhereItRuns
        hosts={hosts}
        agents={[{ ...claude, hosts: hosts.map((h) => ({ hostId: h.id, hostName: h.name, installed: true, coveredByToken: true })) }]}
        where={w}
        onChange={() => {}}
        onAddMachine={() => {}}
      />
    </QueryClientProvider>,
  );
}

const ready: Readiness = {
  user: "root",
  checks: [
    { name: "Firetower worker", available: true, required: true, detail: "0.31.0" },
    { name: "Git", available: true, required: true, detail: "2.47.1" },
  ],
};

describe("the machine hosting Firetower", () => {
  const local = host("local", { type: "Local" }, { execution: "container" });

  it("states the one way it runs rather than offering two", () => {
    const out = draw([local], where({ machine: "local" }), ready);
    expect(out).toContain("the Firetower container");
    // The dead half of the choice is what sent people to a setup dialog that
    // asked them the same question again.
    expect(out).not.toContain("Directly on host");
  });

  it("offers the machine underneath as a machine, not as a mode", () => {
    const out = draw([local], where({ machine: "local" }), ready);
    expect(out).toContain("Add it as a machine");
  });

  it("says so the other way round when Firetower is not in a container", () => {
    const native = host("local", { type: "Local" }, { execution: "host" });
    const out = draw([native], where({ machine: "local" }), ready);
    expect(out).toContain("this machine, as the Firetower account");
    expect(out).not.toContain("Container</button>");
  });
});

describe("a machine Firetower reaches over ssh", () => {
  it("offers both ways of running, whichever are configured", () => {
    const out = draw([host("native", ssh())], where({ machine: "ssh:video-vm:22", execution: "host" }), ready);
    expect(out).toContain("Container");
    expect(out).toContain("Directly on host");
  });

  it("asks which environment only when there really are two of one mode", () => {
    const one = draw(
      [host("native", ssh())],
      where({ machine: "ssh:video-vm:22", execution: "host" }),
      ready,
    );
    expect(one).not.toContain("Which one");

    const two = draw(
      [host("gpu", ssh("worker-gpu")), host("cpu", ssh("worker-cpu"))],
      where({ machine: "ssh:video-vm:22", execution: "container" }),
      ready,
    );
    expect(two).toContain("Which one");
  });

  it("never shows a button for setting an execution environment up", () => {
    const out = draw([host("native", ssh())], where({ machine: "ssh:video-vm:22", execution: "host" }), ready);
    expect(out).not.toContain("Set up an execution environment");
  });
});

describe("a mode a machine has never run", () => {
  it("is made when it is chosen, and says so until it answers", () => {
    const out = draw(
      [host("native", ssh())],
      where({ machine: "ssh:video-vm:22", execution: "container", picked: true }),
      ready,
    );
    expect(out).toContain("Setting this up…");
    // The sentence that used to sit here, beside a dead Create button and a
    // button that reopened the same questions.
    expect(out).not.toContain("not configured");
  });

  it("is not made by merely looking at the machine", () => {
    // Landing on a machine lands on a mode it runs. Otherwise opening the
    // machine list would leave a worker connection behind on every machine
    // somebody glanced at.
    const out = draw(
      [host("native", ssh())],
      where({ machine: "ssh:video-vm:22", execution: "container" }),
      ready,
    );
    expect(out).toContain("Ready — runs as root");
    expect(out).not.toContain("Setting this up…");
  });
});

describe("an environment that goes away", () => {
  it("never falls back to a different worker", () => {
    const out = draw([host("local", { type: "Local" }, { execution: "container" })], where({
      machine: "ssh:video-vm:22",
      execution: "host",
      picked: true,
    }));
    expect(out).toContain("Nowhere to run anything yet");
    expect(out).not.toContain("Ready");
  });
});

describe("what an environment nobody names is called", () => {
  it("is the address, and says so when it is the container one", () => {
    expect(nameFor([], "10.0.4.7", "host")).toBe("10.0.4.7");
    expect(nameFor([], "10.0.4.7", "container")).toBe("10.0.4.7 · container");
  });

  it("does not collide with a name a machine's other environment already has", () => {
    // Built from the address rather than from the sibling's name: a machine
    // whose first environment is `10.0.4.7 · container` would otherwise have
    // its second one called that too, and the server refuses the duplicate.
    const existing = [host("c", ssh("worker", "10.0.4.7"), { name: "10.0.4.7 · container" })];
    expect(nameFor(existing, "10.0.4.7", "host")).toBe("10.0.4.7");
    expect(nameFor(existing, "10.0.4.7", "container")).toBe("10.0.4.7 · container 2");
  });
});

describe("the mode a machine opens on", () => {
  const machineWith = (...hosts: Host[]) => machines(hosts)[0];

  it("is the container, because that is what almost everybody wants", () => {
    expect(defaultMode(machineWith(host("a", ssh("firetower-worker"))))).toBe("container");
  });

  it("is still the container when the machine already has both", () => {
    // It used to be whichever environment the list happened to hold first, so
    // which mode you landed on depended on row order.
    expect(defaultMode(machineWith(host("h", ssh()), host("c", ssh("firetower-worker"))))).toBe(
      "container",
    );
    expect(defaultMode(machineWith(host("c", ssh("firetower-worker")), host("h", ssh())))).toBe(
      "container",
    );
  });

  it("is the host only on a machine that runs nothing else", () => {
    expect(defaultMode(machineWith(host("h", ssh())))).toBe("host");
  });

  it("is the container on a machine with no environments at all", () => {
    expect(defaultMode(undefined)).toBe("container");
  });
});
