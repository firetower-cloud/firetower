import { describe, expect, test } from "vitest";
import { branchFor, seeded } from "./StartComposer";

/**
 * The seeded home: what a task's *Start* puts on the page before anybody
 * presses send.
 *
 * Two of the three parts were already built and invisible — the shelf selects
 * the task's repository and the workspace is named from the issue title. The
 * third was a premise that turned out to be wrong: **the composer was never
 * prefilled.** A task's Start sets `title`, `repo`, `issue`, `taskKey` and
 * `taskUrl`, never `prompt`, and the title and URL reached the agent as a
 * draft handed over *after* the session started. Nobody saw them before
 * pressing send, and the page you landed on was blank.
 */
describe("what the composer opens with", () => {
  test("a task puts its title and its URL in, on two lines", () => {
    expect(
      seeded({ taskKey: "NW-4120", title: "Quota meter goes amber too early", taskUrl: "https://x.invalid/1" }),
    ).toBe("Quota meter goes amber too early\nhttps://x.invalid/1");
  });

  test("an explicit prompt wins — that is how Create with AI arrives", () => {
    expect(seeded({ prompt: "Create a Firetower skill that ", title: "ignored" })).toBe(
      "Create a Firetower skill that ",
    );
  });

  test("and nothing else prefills anything", () => {
    expect(seeded(undefined)).toBe("");
    expect(seeded({})).toBe("");
    /* A title with no task behind it is a workspace name, not something to
       say to an agent. */
    expect(seeded({ title: "auth refactor" })).toBe("");
  });

  test("a task with a URL and no key still seeds", () => {
    expect(seeded({ title: "Keep the v1 embed?", taskUrl: "https://x.invalid/9" })).toBe(
      "Keep the v1 embed?\nhttps://x.invalid/9",
    );
  });
});

describe("the branch, shown before it is cut", () => {
  test("the key leads, then a few words of the title", () => {
    expect(branchFor("Quota meter goes amber too early on the free plan", "NW-4120")).toBe(
      "agent/nw-4120-quota-meter-goes-amber",
    );
  });

  test("the cut is between words, never mid-word", () => {
    const b = branchFor("Reconcile the webhook retries against the ledger-sync mirror", "NW-77");
    expect(b).toBe("agent/nw-77-reconcile-the-webhook");
    expect(b.endsWith("-")).toBe(false);
  });

  test("and never ends on an article or a preposition", () => {
    /* `quota-meter-rounds-the` reads as a sentence that was interrupted. */
    expect(branchFor("Quota meter rounds the wrong way at 99.5%", "#5138")).toBe(
      "agent/5138-quota-meter-rounds",
    );
  });

  test("no key is the behaviour it has always had — the first line, slugged", () => {
    expect(branchFor("auth refactor")).toBe("agent/auth-refactor");
    /* The whole line, capped at `slug`'s 48 characters — not a few words.
       Shortening every branch in the build was not what was asked for. */
    expect(branchFor("Quota meter goes amber too early on the free plan")).toBe(
      "agent/quota-meter-goes-amber-too-early-on-the-free-plan",
    );
  });

  test("a title that slugs to nothing still names something", () => {
    expect(branchFor("···")).toBe("agent/work");
    expect(branchFor("···", "NW-1")).toBe("agent/nw-1");
  });

  test("the key survives the title being edited, which is why it leads", () => {
    const before = branchFor("Quota meter goes amber", "NW-4120");
    const after = branchFor("Rewrite the quota parser", "NW-4120");
    expect(before).not.toBe(after);
    expect(before.startsWith("agent/nw-4120-")).toBe(true);
    expect(after.startsWith("agent/nw-4120-")).toBe(true);
  });
});
