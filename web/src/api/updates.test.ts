import { describe, expect, it } from "vitest";
import type { FilePlan, HostTarget, UpdateRun, UpdateStatus } from "./generated/model";
import {
  countEnded,
  diffLines,
  duration,
  everythingUpgradable,
  hostNote,
  needsChoice,
  nothingChosen,
  runSummary,
  showsDot,
  willWrite,
  wouldEnd,
} from "./updates";

const host = (over: Partial<HostTarget> = {}): HostTarget => ({
  hostId: "h_1",
  name: "fire-01",
  kind: "container",
  version: "0.30.1",
  online: true,
  drained: false,
  upgradable: true,
  reason: null,
  sessions: [],
  ...over,
});

const status = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({
  current: "0.30.1",
  latest: {
    version: "0.31.0",
    publishedAt: null,
    notesUrl: null,
    notes: null,
    cliMinimum: null,
  },
  checkedAt: null,
  checkError: null,
  updateAvailable: true,
  controlPlane: {
    version: "0.30.1",
    upgradable: true,
    reason: null,
    sessions: ["ledger", "api"],
    updater: { configured: true, reachable: true, version: "0.30.1", apiVersion: 1, problem: null },
  },
  hosts: [
    host(),
    host({ hostId: "h_2", name: "hetzner-2", sessions: ["web"] }),
    host({ hostId: "h_3", name: "gcp-old", kind: "binary", upgradable: false, reason: "installed by hand" }),
  ],
  activeRun: null,
  ...over,
});

describe("what starts ticked", () => {
  it("is everything that can be moved, and nothing that cannot", () => {
    const chosen = everythingUpgradable(status());
    expect(chosen.controlPlane).toBe(true);
    expect(chosen.hostIds).toEqual(["h_1", "h_2"]);
    expect(nothingChosen(chosen)).toBe(false);
    expect(nothingChosen({ controlPlane: false, hostIds: [] })).toBe(true);
  });
});

describe("what a run would end", () => {
  it("names the sessions by where they are", () => {
    const ended = wouldEnd(status(), { controlPlane: true, hostIds: ["h_1", "h_2"] });
    expect(ended).toEqual([
      { where: "this machine", sessions: ["ledger", "api"] },
      { where: "hetzner-2", sessions: ["web"] },
    ]);
    expect(countEnded(ended)).toBe(3);
  });

  it("counts only what was chosen", () => {
    expect(countEnded(wouldEnd(status(), { controlPlane: false, hostIds: ["h_1"] }))).toBe(0);
  });
});

describe("a host row's note", () => {
  it("says why when there is a reason, otherwise what it costs", () => {
    expect(hostNote(host({ reason: "installed by hand" }))).toBe("installed by hand");
    expect(hostNote(host({ sessions: ["a"] }))).toBe("ends a session");
    expect(hostNote(host({ sessions: ["a", "b"] }))).toBe("ends 2 sessions");
    expect(hostNote(host())).toBe("idle");
  });
});

describe("deployment files", () => {
  const file = (verdict: FilePlan["verdict"]): FilePlan => ({
    name: "firetower.yml",
    verdict,
    releaseChange: null,
    yourEdits: null,
  });

  it("only an edited file asks", () => {
    expect(needsChoice(file("Edited"))).toBe(true);
    expect(needsChoice(file("Update"))).toBe(false);
  });

  it("writes what the release changed, and an edited file only when told", () => {
    expect(willWrite(file("Update"), false)).toBe(true);
    expect(willWrite(file("New"), false)).toBe(true);
    expect(willWrite(file("Edited"), false)).toBe(false);
    expect(willWrite(file("Edited"), true)).toBe(true);
    expect(willWrite(file("Unchanged"), true)).toBe(false);
  });
});

describe("history", () => {
  const run = (over: Partial<UpdateRun> = {}): UpdateRun => ({
    id: "upg_1",
    fromVersion: "0.30.1",
    toVersion: "0.31.0",
    targets: { controlPlane: true, hostIds: [] },
    whenIdle: false,
    state: "succeeded",
    startedBy: null,
    createdAt: "2026-09-11T14:02:00Z",
    startedAt: "2026-09-11T14:02:00Z",
    finishedAt: "2026-09-11T14:06:12Z",
    error: null,
    steps: [],
    ...over,
  });

  it("says what moved, how it went and how long it took", () => {
    expect(runSummary(run())).toBe("0.30.1 → 0.31.0 · succeeded · 4m12s");
    expect(runSummary(run({ state: "running", finishedAt: null }))).toBe(
      "0.30.1 → 0.31.0 · running",
    );
  });

  it("measures durations in the unit they are read in", () => {
    expect(duration("2026-09-11T14:02:00Z", "2026-09-11T14:02:18Z")).toBe("18s");
    expect(duration("2026-09-11T14:02:00Z", "2026-09-11T15:05:00Z")).toBe("1h03m");
    expect(duration(null)).toBe("");
  });
});

describe("the rail's dot", () => {
  it("shows for an update or a run in progress, and not otherwise", () => {
    expect(showsDot(status())).toBe(true);
    expect(showsDot(status({ updateAvailable: false }))).toBe(false);
    expect(showsDot(status({ updateAvailable: false, activeRun: "upg_1" }))).toBe(true);
    expect(showsDot(undefined)).toBe(false);
  });
});

describe("a diff on screen", () => {
  it("knows which lines are which", () => {
    const lines = diffLines("--- a\n+++ a\n@@ -1 +1 @@\n-old\n+new\n same\n");
    expect(lines.map((l) => l.kind)).toEqual(["meta", "meta", "hunk", "del", "add", "same"]);
  });
});
