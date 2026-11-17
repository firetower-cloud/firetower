/**
 * What Export says, which is the whole of what the feature says to anybody.
 *
 * A `PROFILE.md` is only a profile when it is in a folder named after it, so
 * the one thing the message has to carry is where to put the file. The second
 * case is the one worth pinning: the form exports the *saved* profile, and a
 * person who has typed into it and not saved would otherwise commit a file
 * that quietly lags the screen in front of them.
 */
import { describe, expect, it } from "vitest";
import { copied } from "./Roles";

describe("what export says", () => {
  it("names the path the file belongs at", () => {
    expect(copied("profiles/engineering-manager/PROFILE.md", false)).toBe(
      "Copied. Paste it at profiles/engineering-manager/PROFILE.md.",
    );
  });

  it("says which version it copied when the form has edits in it", () => {
    expect(copied("profiles/designer/PROFILE.md", true)).toBe(
      "Copied the saved profile, not your unsaved edits. Paste it at profiles/designer/PROFILE.md.",
    );
  });
});
