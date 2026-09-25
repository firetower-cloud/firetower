import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WhereItRuns, resolve, canRun, type Where } from "./WhereItRuns";
import { getHostReadinessQueryKey } from "@/src/api/generated/hosts/hosts";
import type { AgentView, Host, Readiness } from "@/src/api/generated/model";

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
const ssh = (at = "video-vm", user?: string): Host["compute"] => ({
  type: "Server",
  host: at,
  user,
  key: { type: "Managed" },
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

describe("a machine", () => {
  it("is a place, with no mode to pick", () => {
    const out = draw([host("native", ssh())], where({ machine: "ssh:video-vm:22" }), ready);
    expect(out).toContain("Ready — runs as root");
    // The pair of radios that used to sit here, and the setup dialog behind them.
    expect(out).not.toContain("Run in");
    expect(out).not.toContain("Directly on host");
    expect(out).not.toContain("Container</button>");
    expect(out).not.toContain("Set up an execution environment");
  });

  it("asks which environment only when the same machine is reached as two accounts", () => {
    const one = draw([host("native", ssh())], where({ machine: "ssh:video-vm:22" }), ready);
    expect(one).not.toContain("Which one");

    const two = draw(
      [host("editor", ssh("video-vm", "editor")), host("root", ssh("video-vm", "root"))],
      where({ machine: "ssh:video-vm:22" }),
      ready,
    );
    expect(two).toContain("Which one");
  });

  it("is the machine hosting Firetower when that is what was picked", () => {
    const out = draw([host("local", { type: "Local" })], where({ machine: "local" }), ready);
    expect(out).toContain("Ready — runs as root on this machine");
  });
});

describe("an environment that goes away", () => {
  it("never falls back to a different worker", () => {
    const out = draw([host("local", { type: "Local" })], where({ machine: "ssh:video-vm:22" }));
    expect(out).toContain("Nowhere to run anything yet");
    expect(out).not.toContain("Ready");
  });

  it("resolves to nothing rather than to whatever is first", () => {
    const hosts = [host("local", { type: "Local" })];
    expect(resolve(hosts, where({ machine: "ssh:video-vm:22" })).host).toBeUndefined();
    expect(resolve(hosts, where()).host?.id).toBe("local");
  });
});


it("Kimi needs a connected account, like every other agent that has a login", () => {
  // It used to run on whatever `kimi login` had left on the worker. Its
  // credential is Firetower's to hold now, so an agent without one cannot
  // start — the same rule Claude and Codex have always had.
  const kimi: AgentView = { ...claude, kind: "KimiCode", needsCredential: true, credentialSet: false, hosts: [{ hostId: "local", hostName: "Local", installed: true, coveredByToken: false, loggedIn: null }] };
  expect(canRun(kimi, "local")).toBe(false);
  expect(canRun({ ...kimi, credentialSet: true }, "local")).toBe(true);
  expect(canRun({ ...kimi, credentialSet: true }, "absent")).toBe(false);
});
