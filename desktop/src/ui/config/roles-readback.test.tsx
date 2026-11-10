/**
 * The sentence under the three fields, which says what a spawn will actually
 * be.
 *
 * It exists because the bug this screen was changed for is a lead reporting a
 * build that never happened — so what is worth proving is narrow: every
 * combination of committed and open reads as one true sentence, and the
 * all-open case says so in its own words rather than repeating "whatever the
 * lead asks for" three times.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { whatAChildGets } from "./Roles";
import type { NewRole } from "~/api/generated/model";

const MACHINES = [{ id: "h_1", label: "build-01" }];

function reads(over: Partial<NewRole>, machines = MACHINES) {
  const draft = {
    name: "QA",
    does: "runs it",
    placement: "lead",
    agent: null,
    machine: null,
    account: null,
    settings: {},
    instructions: "",
    canDelegate: false,
    delegateScope: [],
    skillScope: [],
    directory: null,
    ...over,
  } as NewRole;
  /* Tags off, and the one entity `renderToStaticMarkup` escapes put back:
     the apostrophe in "the lead's own workspace" is the sentence, not markup. */
  return renderToStaticMarkup(<p>{whatAChildGets(draft, machines)}</p>)
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'");
}

describe("what a child gets", () => {
  it("says the lead decides all of it when nothing is pinned", () => {
    expect(reads({})).toBe("A child gets whatever the lead asks for: its workspace, its machine, its engine.");
  });

  it("names a pinned engine and a pinned machine", () => {
    expect(reads({ placement: "new", machine: "h_1", agent: "ClaudeCode" })).toBe(
      "A child gets a workspace of its own, on build-01, running Claude Code.",
    );
  });

  it("says who picks the machine when the machine is open", () => {
    expect(reads({ placement: "new", agent: "Codex" })).toBe(
      "A child gets a workspace of its own, on a machine the lead names or Firetower picks, running Codex.",
    );
  });

  /* A machine cannot apply to a child in the lead's own workspace, so it is
     not mentioned — the field is not even on screen for that placement. */
  it("says nothing about a machine for a shared workspace", () => {
    expect(reads({ placement: "here", agent: "ClaudeCode" })).toBe(
      "A child gets the lead's own workspace, running Claude Code.",
    );
  });

  /* The one combination the list view cannot show honestly in a word: a
     machine pinned under an open placement is a conditional commitment. */
  it("keeps a pinned machine under an open placement", () => {
    expect(reads({ placement: "lead", machine: "h_1", agent: "ClaudeCode" })).toBe(
      "A child gets whichever workspace the lead asks for, on build-01, running Claude Code.",
    );
  });

  /* Before the first machine is added there is nothing to pick from, and
     "Firetower picks" would be a promise about an empty fleet. */
  it("says what happens before any machine exists", () => {
    expect(reads({ placement: "new", agent: "ClaudeCode" }, [])).toBe(
      "A child gets a workspace of its own, on the first machine you add, running Claude Code.",
    );
  });
});
