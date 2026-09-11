import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Readout, isReady } from "./HostReadiness";
import { getHostReadinessQueryKey } from "@/src/api/generated/hosts/hosts";
import type { Host, Readiness } from "@/src/api/generated/model";

const server = (container?: string): Host => ({
  id: "h1",
  name: "video-vm",
  compute: { type: "Server", host: "192.0.2.10", user: "editor", key: { type: "Managed" }, container },
  state: container ? "Online" : "Unreachable",
  drained: false,
  reconnecting: false,
  docker: { status: "Unknown" },
  execution: container ? "container" : "host",
});

function draw(host: Host, report: Readiness) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false } },
  });
  cache.setQueryData(getHostReadinessQueryKey(host.id, { agent: "ClaudeCode" }), report);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <Readout host={host} agent="ClaudeCode" agentLabel="Claude Code" />
    </QueryClientProvider>,
  );
}

const pass = (name: string, detail = "ok") => ({
  name,
  detail,
  available: true,
  required: true,
});
const fail = (name: string, detail = "not installed", remedy?: string) => ({
  name,
  detail,
  available: false,
  required: true,
  remedy,
});

describe("when everything is ready", () => {
  const report: Readiness = {
    user: "root",
    checks: [pass("Firetower worker", "0.31.0"), pass("Git", "2.47.1"), pass("tmux", "3.5a")],
  };

  it("is one sentence, not a list of things that are fine", () => {
    const out = draw(server("firetower-worker"), report);
    expect(out).toContain("Ready — runs as root");
    // The old card put every passing check on screen, on a form people fill in
    // twenty times a day.
    expect(out).not.toContain("2.47.1");
    expect(out).not.toContain("3.5a");
  });

  it("still says how many were checked, and offers them", () => {
    expect(draw(server("firetower-worker"), report)).toContain("3 checks");
  });

  it("names the environment a container runs in, and the machine a host does", () => {
    expect(draw(server("firetower-worker"), report)).toContain("in video-vm");
    expect(draw(server(), { ...report, user: "editor" })).toContain("on editor@192.0.2.10");
  });
});

describe("when there is no worker on the machine yet", () => {
  const report: Readiness = {
    checks: [fail("Worker connection", "The worker is not connected.", "Install it. See docs.")],
  };

  it("says that, rather than counting requirements it could not measure", () => {
    const out = draw(server(), report);
    expect(out).toContain("There is no worker on editor@192.0.2.10 yet");
  });

  it("offers to put one there, because it can", () => {
    const out = draw(server(), report);
    expect(out).toContain("Install the worker");
    expect(out).toContain("~/.firetower/worker/bin");
    // What was here before: a Rust toolchain on a machine whose whole purpose
    // is to not have things installed on it.
    expect(out).not.toContain("cargo build");
  });

  it("does not offer that for a container, whose worker comes from its image", () => {
    const out = draw(server("firetower-worker"), report);
    expect(out).not.toContain("Install the worker");
  });
});

describe("when the worker is there and something else is not", () => {
  const report: Readiness = {
    user: "editor",
    checks: [
      pass("Firetower worker", "0.31.0"),
      pass("Git", "2.43.0"),
      fail("tmux", "Missing", "sudo apt install tmux"),
      fail("Claude Code", "no executable"),
      pass("Shell", "/bin/sh"),
    ],
  };

  it("itemises what is missing and collapses what is not", () => {
    const out = draw(server(), report);
    expect(out).toContain("2 things are missing on editor@192.0.2.10");
    expect(out).toContain("tmux");
    expect(out).toContain("Claude Code");
    expect(out).toContain("Firetower worker, Git, Shell — all fine.");
  });

  it("offers the agent as a button, since Firetower can fetch that itself", () => {
    expect(draw(server(), report)).toContain(">Install<");
  });

  it("gives the package manager as something to copy, since that one is yours", () => {
    const out = draw(server(), report);
    expect(out).toContain("sudo apt install tmux");
    // Once. It was in the row's own detail as well, so the same command was
    // printed twice on the same line.
    expect(out.split("sudo apt install tmux")).toHaveLength(2);
  });
});

describe("what counts as ready", () => {
  it("ignores an optional thing that is missing", () => {
    expect(isReady({ checks: [pass("Git"), { ...fail("npm"), required: false }] })).toBe(true);
  });

  it("is not ready on no checks at all, which is what an empty answer is", () => {
    expect(isReady({ checks: [] })).toBe(false);
    expect(isReady(undefined)).toBe(false);
  });
});
