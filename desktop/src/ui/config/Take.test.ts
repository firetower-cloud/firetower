import { describe, expect, it } from "vitest";
import { says } from "./Take";

/**
 * The states of the one control that puts something in the library.
 *
 * **Written because the order was wrong in a way nothing could catch.** Every
 * branch rendered correctly on its own; `waiting` simply sat above
 * `connected`, so a server that had authorized kept spinning. A decision with
 * five outcomes and a precedence between them is a table, and a table is a
 * test.
 */
describe("what the control says", () => {
  const server = { hasConnector: true, installed: true };

  it("says it is connected even while a browser tab is outstanding", () => {
    // Canva, measured: connected=true on the control plane, and the row had
    // opened a tab so `waiting` was still set. It showed "Waiting…".
    expect(says({ ...server, connected: true }, false, true)).toBe("done");
  });

  it("says it is connected even if the entry also wants a client id", () => {
    // Supplying one by hand and then authorizing leaves both flags set.
    expect(says({ ...server, connected: true, needsClientId: true })).toBe("done");
  });

  it("waits only while there is nothing better to say", () => {
    expect(says({ ...server, connected: false }, false, true)).toBe("waiting");
  });

  it("sends somebody to the form when the server hands out no clients", () => {
    expect(says({ ...server, connected: false, needsClientId: true })).toBe("set-up");
    // And still does once a tab has been opened, because that tab cannot
    // have worked.
    expect(says({ ...server, connected: false, needsClientId: true }, false, true)).toBe(
      "set-up",
    );
  });

  it("offers itself when nothing has happened yet", () => {
    expect(says({ hasConnector: true, installed: false })).toBe("offer");
    expect(says({ hasConnector: false, installed: false })).toBe("offer");
  });

  it("counts a skills-only entry as done the moment it is installed", () => {
    // Nothing follows an Add when there is no server to authorize.
    expect(says({ hasConnector: false, installed: true })).toBe("done");
  });

  it("lets an in-flight press win over everything", () => {
    expect(says({ ...server, connected: true }, true)).toBe("busy");
  });

  it("does not offer Set it up for something that is not installed", () => {
    // `needsClientId` is a fact about an installed row; a catalogue row has
    // not asked the server anything yet.
    expect(says({ hasConnector: true, installed: false, needsClientId: true })).toBe("offer");
  });
});
