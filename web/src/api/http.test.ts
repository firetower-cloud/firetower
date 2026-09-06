import { describe, expect, it } from "vitest";
import { meansSignedOut } from "./http";

/** Somewhere that is not the sign-in screen. */
const ANYWHERE = "/api/v1/sessions";

describe("deciding that a refusal ended the session", () => {
  it("is the one code that means we do not know who you are", () => {
    expect(meansSignedOut("Unauthorized", ANYWHERE)).toBe(true);
  });

  /**
   * The regression this exists for. Both of these answered 401 once, and the
   * interface read the status rather than the code — so a GitHub authorization
   * nobody had done yet threw the token away and went to the sign-in screen.
   */
  it("is not a git host we hold no credential for", () => {
    expect(meansSignedOut("ProviderNotConnected", "/api/v1/tasks")).toBe(false);
    expect(meansSignedOut("RepoAccessDenied", "/api/v1/repos/probe")).toBe(false);
  });

  it("is not anything else that failed", () => {
    for (const code of ["NotFound", "Internal", "NoCapacity", "InvalidRequest", "SessionEnded"]) {
      expect(meansSignedOut(code, ANYWHERE)).toBe(false);
    }
  });

  /**
   * A body that could not be read at all arrives as `Internal`, whatever the
   * status was. Something in front of Firetower refusing the request is not
   * this browser's session ending, and throwing the token away would not help.
   */
  it("is not a refusal we could not read", () => {
    expect(meansSignedOut("Internal", ANYWHERE)).toBe(false);
  });

  /**
   * The wrong password is the answer to the question that screen is asking.
   * Reacting to it by navigating to the screen somebody is already on would
   * reload the page out from under the form.
   */
  it("is never signing in, however it was refused", () => {
    expect(meansSignedOut("Unauthorized", "/api/v1/auth/login")).toBe(false);
  });
});
