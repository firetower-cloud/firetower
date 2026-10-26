import { describe, expect, it } from "vitest";
import { noteTarget } from "./target";

const running = [{ id: "s_live" }, { id: "s_other" }];

describe("who a note on an artifact goes to", () => {
  it("is the workspace's own agent when it was opened in one", () => {
    expect(
      noteTarget({ fixed: "s_here", picked: undefined, running, origin: "s_gone" }),
    ).toBe("s_here");
  });

  /* The tab's own session, not something remembered — so it is not checked
     against the list the way a choice is. */
  it("trusts a workspace's own agent even while the list is still loading", () => {
    expect(
      noteTarget({ fixed: "s_here", picked: undefined, running: [], origin: null }),
    ).toBe("s_here");
  });

  it("offers the workspace that made it, when that is still running", () => {
    expect(
      noteTarget({ fixed: null, picked: undefined, running, origin: "s_live" }),
    ).toBe("s_live");
  });

  /* The bug this was written for: `fromSessionId` outlives the session, so a
     library full of reclaimed workspaces was full of enabled buttons that
     404'd. */
  it("offers nothing when the workspace that made it is gone", () => {
    expect(
      noteTarget({ fixed: null, picked: undefined, running, origin: "s_reclaimed" }),
    ).toBeNull();
  });

  it("offers nothing when the artifact never recorded a workspace", () => {
    expect(
      noteTarget({ fixed: null, picked: undefined, running, origin: null }),
    ).toBeNull();
  });

  it("takes what the person chose over what made it", () => {
    expect(
      noteTarget({ fixed: null, picked: "s_other", running, origin: "s_live" }),
    ).toBe("s_other");
  });

  /* `null` is a decision — "not that one" — and must not fall back to the
     suggestion, or clearing the choice would silently re-arm the default. */
  it("treats clearing the choice as a choice", () => {
    expect(
      noteTarget({ fixed: null, picked: null, running, origin: "s_live" }),
    ).toBeNull();
  });

  /* The other half of the same bug: a session chosen a minute ago can have
     ended while the notes were being written. */
  it("drops a choice whose session has since ended", () => {
    expect(
      noteTarget({ fixed: null, picked: "s_live", running: [{ id: "s_other" }], origin: null }),
    ).toBeNull();
  });

  it("offers nothing when nothing is running", () => {
    expect(
      noteTarget({ fixed: null, picked: undefined, running: [], origin: "s_live" }),
    ).toBeNull();
  });
});
