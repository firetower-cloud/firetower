/**
 * The pinned subscription, and the list it is reconciled against.
 *
 * A profile pins a concrete account id, and the editor drops a pin that no
 * longer fits the engine — right, and the whole question is *when it may say
 * so*. `useAccounts()` reads `[]` while its query is in flight, so on a cold
 * open the reconcile ran against an empty list, found a genuine pin absent and
 * set it to `null`; the form then read *Your default for Claude Code* and Save
 * wrote that loss back. Nothing logged, nothing refused — this screen's own
 * subject, which is why it is a test and not a comment.
 *
 * Both directions are here, because the fix is not "never drop a pin":
 *
 * - an **unanswered** list is not an answer, and the pin is kept;
 * - an **empty answered** list is a real answer — no usable subscription for
 *   this engine — and the stale pin still comes off.
 *
 * Nothing here needs the component: the gate is the third argument, and what a
 * cold open is, is `answered: false`.
 */
import { describe, expect, it } from "vitest";
import { pinnedAccountFits } from "./Roles";
import type { Account } from "~/api/accounts";

const account = (over: Partial<Account> = {}): Account =>
  ({
    id: "aa_team",
    kind: "ClaudeCode",
    name: "Team plan",
    mode: "subscription",
    state: "connected",
    enabled: true,
    credentialSet: true,
    isDefault: false,
    ...over,
  }) as Account;

/** The owner's other one, which is the default — what the pin was losing to. */
const MINE = account({ id: "aa_mine", name: "Mine", isDefault: true });
const TEAM = account();

describe("a pinned subscription, against the list that may unpin it", () => {
  it("keeps the pin while the list is still in flight", () => {
    expect(pinnedAccountFits("aa_team", "ClaudeCode", [], false)).toBe(true);
  });

  it("keeps the pin when the list has arrived and holds it", () => {
    expect(pinnedAccountFits("aa_team", "ClaudeCode", [MINE, TEAM], true)).toBe(true);
  });

  /* The reason the reconcile exists: an account belongs to one engine, so a
     Claude Code pin means nothing to a profile that now names Codex. */
  it("drops a pin for another engine", () => {
    expect(pinnedAccountFits("aa_team", "Codex", [MINE, TEAM], true)).toBe(false);
  });

  /* A row that was started and never finished is in the list and is not
     something a profile can run on — `usable` is the same test the picker
     makes, so the two cannot drift apart. */
  it("drops a pin on a subscription that is no longer usable", () => {
    expect(pinnedAccountFits("aa_team", "ClaudeCode", [account({ enabled: false })], true)).toBe(
      false,
    );
  });

  /* An empty list *after* the answer is an answer. This is the case gating on
     `accounts.length` would have got wrong in the other direction. */
  it("drops the pin when the answered list is empty", () => {
    expect(pinnedAccountFits("aa_team", "ClaudeCode", [], true)).toBe(false);
  });
});
