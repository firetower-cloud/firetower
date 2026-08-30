import { describe, expect, it } from "vitest";
import { ready, type Line } from "./Steps";
import type { Step } from "@/src/api/generated/model";

const line = (step: Step, state: Line["state"]): Line => ({ step, state, detail: "" });

/**
 * Whether the workspace is up and it is your turn.
 *
 * This exists because of a session that looked hung. Its bring-up had actually
 * finished, but a done step kept its present tense and drew no mark, so
 * "Starting the agent" was the last thing on screen — and with no first prompt
 * there was nothing after it. The agent had been waiting the whole time.
 */
describe("whether the workspace is up", () => {
  it("is ready once every step that ran is done and the agent was launched", () => {
    expect(
      ready([line("Workspace", "done"), line("Fetch", "done"), line("Launch", "done")]),
    ).toBe(true);
  });

  it("is not ready while anything is still going", () => {
    expect(ready([line("Fetch", "done"), line("Launch", "running")])).toBe(false);
  });

  it("is not ready when a step failed", () => {
    expect(ready([line("Fetch", "failed"), line("Launch", "pending")])).toBe(false);
  });

  it("is not ready before the agent was launched at all", () => {
    // Everything so far worked, but the launch has not been reached — a
    // workspace being built, not one waiting on you.
    expect(ready([line("Workspace", "done"), line("Fetch", "done")])).toBe(false);
  });

  it("ignores steps that were never going to run", () => {
    // A repository with no setup script leaves `Setup` pending forever, and
    // that must not hold the whole thing back.
    expect(
      ready([line("Fetch", "done"), line("Launch", "done"), line("Setup", "pending")]),
    ).toBe(true);
  });

  it("claims nothing about a session with no bring-up recorded", () => {
    // Sessions from before steps existed. Nothing here knows, so nothing here
    // says the agent is waiting.
    expect(ready([])).toBe(false);
  });
});
