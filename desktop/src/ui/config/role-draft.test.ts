/**
 * The one promise `toDraft` makes: **it carries every field of a `Role`.**
 *
 * `update_role` takes the whole object, so a field the editor fails to put in
 * a draft is a field the save blanks. The doc comment on `toDraft` has said so
 * since it was written — and then the hazard fired anyway: the two inheritance
 * switches were added to `Role` and to `NewRole` and not to `toDraft`, so every
 * existing profile opened reading *"It loads no skills from Firetower"* over a
 * button offering to **Save with no skills**, for profiles that load four. The
 * same gap went out with nobody at the keyboard, through the write
 * `Machines.tsx` makes when a machine is removed.
 *
 * Nothing failed, because both fields are optional on `NewRole` — which is the
 * part worth fixing. Adding the two properties would have closed the one
 * report; this closes the class. Two gates, and a new field on `Role` has to
 * pass both:
 *
 * 1. **The type checker.** `EVERY_FIELD` is typed `Record<keyof Role, …>`, so a
 *    field added to `Role` and not to the fixture does not compile.
 * 2. **The loop.** Once in the fixture, the field must turn up in the draft or
 *    be named in `SERVER_OWNED` — a list with a reason attached, so dropping
 *    one stays a decision somebody wrote down rather than something nobody saw.
 */
import { describe, expect, it } from "vitest";
import type { Role } from "~/api/generated/model";
import { SERVER_OWNED, toDraft } from "./Roles";

/**
 * A `Role` with every field set, each to something it would not be by
 * accident.
 *
 * Distinctive values, not plausible ones: a fixture that happened to match
 * what a buggy `toDraft` hardcodes would pass while the bug shipped, and that
 * is the exact failure here — `BLANK` sets both switches `true`, so a draft
 * that dropped them looked right on a new profile and wrong on every other
 * one. Both are `false` below for that reason.
 */
const EVERY_FIELD: Role & Record<keyof Role, unknown> = {
  id: "role_1",
  path: "d/firetower/reviewer",
  name: "Reviewer",
  does: "reads a branch and reports problems",
  placement: "new",
  agent: "ClaudeCode",
  machine: "h_1",
  account: "aa_1",
  settings: { model: "opus", effort: "high", mode: "ask", sandbox: "off" },
  instructions: "Report findings as path:line.",
  onUsageLimit: "engine",
  onChildLimit: "reroute",
  canDelegate: true,
  delegateScope: ["role_2"],
  includeAlwaysOn: false,
  includeRepoDefaults: false,
  skillScope: ["sk_1"],
  mayWrite: true,
  mayShare: true,
  isDefault: true,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-08T00:00:00Z",
};

/**
 * What a draft carries that a `Role` does not have: where to file a new
 * profile, which is only read at creation and is nobody's business on a save.
 */
const WRITE_ONLY = ["directory"];

const owned = new Set<string>(SERVER_OWNED);

describe("a profile as the form that edits it", () => {
  const draft = toDraft(EVERY_FIELD);

  it("carries every field of a Role that is not the server's to set", () => {
    for (const field of Object.keys(EVERY_FIELD)) {
      if (owned.has(field)) continue;
      // Both halves matter: the key has to be there *and* it has to be what
      // the role said. A hardcoded value is as wrong as a missing one.
      expect(draft, `toDraft does not carry ${field}`).toHaveProperty(field, EVERY_FIELD[field as keyof Role]);
    }
  });

  it("leaves out exactly the fields the server owns", () => {
    for (const field of SERVER_OWNED) {
      expect(draft, `toDraft sends back ${field}, which the server decides`).not.toHaveProperty(field);
    }
  });

  /**
   * The other direction, so a field added to `NewRole` alone is noticed too:
   * a draft key that is neither a role's field nor deliberately write-only is
   * something the editor invented.
   */
  it("invents nothing a Role does not have, beyond where to file a new one", () => {
    const known = new Set([...Object.keys(EVERY_FIELD), ...WRITE_ONLY]);
    expect(Object.keys(draft).filter((k) => !known.has(k))).toEqual([]);
  });

  /**
   * The reported bug, said as the symptom rather than as a field list — this
   * is what the screenshots showed, and it fails on a `toDraft` that drops the
   * two switches whatever the fixture above grows into.
   */
  it("opens a narrowed profile narrowed, rather than reporting it loads nothing", () => {
    expect(draft.includeAlwaysOn).toBe(false);
    expect(draft.includeRepoDefaults).toBe(false);

    const both = toDraft({ ...EVERY_FIELD, includeAlwaysOn: true, includeRepoDefaults: true });
    expect(both.includeAlwaysOn).toBe(true);
    expect(both.includeRepoDefaults).toBe(true);
  });
});
