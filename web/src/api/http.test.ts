import { describe, expect, it } from "vitest";
import { afterSignIn, meansSignedOut, returnPath } from "./http";

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

/**
 * `?next=` is a redirect target somebody else wrote, on the one screen in the
 * product that takes a password.
 *
 * It exists because the renderer's *change password* button sends a browser to
 * `/account`, which needs a session that browser does not have — the two
 * halves of the product keep theirs under different keys on the same origin —
 * so the visitor is bounced here and has to be put back afterwards or the only
 * voluntary password form in the product is unreachable from the only control
 * that offers it.
 *
 * **A sign-in page that forwards anywhere it is told to is a phishing
 * primitive.** The link is ours, the form is ours, the password is really
 * typed into it, and the landing is somebody else's. So these are the shapes
 * an attacker writes, asked of the rule directly.
 */
const HERE = "http://127.0.0.1:30757";

describe("where ?next= may put somebody after they sign in", () => {
  it("is a path on this origin", () => {
    expect(returnPath("/account", HERE)).toBe("/account");
    expect(returnPath("/setup", HERE)).toBe("/setup");
    expect(returnPath("/", HERE)).toBe("/");
    expect(returnPath("/account?from=app#password", HERE)).toBe("/account?from=app#password");
  });

  it("is nowhere at all when nothing was asked for", () => {
    expect(returnPath(null, HERE)).toBeNull();
    expect(returnPath(undefined, HERE)).toBeNull();
    expect(returnPath("", HERE)).toBeNull();
  });

  /* The attack in its plainest form: an absolute URL to somewhere else. */
  it("is never another origin, however it is written", () => {
    expect(returnPath("https://evil.example/pay", HERE)).toBeNull();
    expect(returnPath("http://evil.example/pay", HERE)).toBeNull();
    // Same host, other scheme and other port are other origins too.
    expect(returnPath("https://127.0.0.1:30757/account", HERE)).toBeNull();
    expect(returnPath("http://127.0.0.1:4400/account", HERE)).toBeNull();
  });

  /**
   * The ones that begin with a slash and are still not ours.
   *
   * `//host` is a protocol-relative URL, and a browser normalises `\\` to `/`
   * before it parses — so `/\\evil.example` is the same address written in a
   * way a `startsWith("//")` check does not see. The URL parser settles it
   * rather than a list of prefixes with one missing from it.
   */
  it("is never another origin disguised as a path", () => {
    expect(returnPath("//evil.example/pay", HERE)).toBeNull();
    expect(returnPath("/\\evil.example/pay", HERE)).toBeNull();
    expect(returnPath("/\\/evil.example", HERE)).toBeNull();
  });

  /**
   * And the one that passes both of the checks above.
   *
   * `/..//evil.example` is written as a path and resolves to this origin — but
   * its *pathname* is `//evil.example`, which is protocol-relative all over
   * again the moment it is handed to `location`. Checking only what came in
   * would have shipped the hole the rule was written to close.
   */
  it("is never a path that becomes another origin when it is used", () => {
    expect(returnPath("/..//evil.example", HERE)).toBeNull();
    expect(returnPath("/../..//evil.example/pay", HERE)).toBeNull();
  });

  /* Not a path at all. `javascript:` is the one that matters — handing it to
     `location` would run it on our origin, with our session. */
  it("is never a scheme that is not a page", () => {
    expect(returnPath("javascript:alert(document.cookie)", HERE)).toBeNull();
    expect(returnPath("data:text/html,<script>1</script>", HERE)).toBeNull();
    // A relative reference means whatever the page it is read on makes it
    // mean, which is not a thing to forward somebody to.
    expect(returnPath("account", HERE)).toBeNull();
    expect(returnPath("../account", HERE)).toBeNull();
  });
});

/**
 * And the order the three are asked in.
 *
 * `?next=` is written by whoever made the link, so the thing worth being sure
 * of is not that it works but that it cannot overtake the gate: somebody who
 * still owes a password is refused every request until it is replaced, and a
 * query parameter must not route them past the one screen that fixes that.
 */
describe("where a successful sign-in goes", () => {
  it("is the setup wizard while anything is outstanding, whatever was asked for", () => {
    expect(afterSignIn(true, "?next=/account", HERE)).toEqual({ to: "setup" });
    expect(afterSignIn(true, "?next=/", HERE)).toEqual({ to: "setup" });
    expect(afterSignIn(true, "", HERE)).toEqual({ to: "setup" });
  });

  it("is where they were going, once nothing is outstanding", () => {
    expect(afterSignIn(false, "?next=%2Faccount", HERE)).toEqual({ to: "load", path: "/account" });
    expect(afterSignIn(false, "?next=/account", HERE)).toEqual({ to: "load", path: "/account" });
  });

  it("is the application when nothing was asked for", () => {
    expect(afterSignIn(false, "", HERE)).toEqual({ to: "load", path: "/" });
    expect(afterSignIn(false, "?other=1", HERE)).toEqual({ to: "load", path: "/" });
  });

  /* A refused `next` is not an error to show anybody — it is a link that was
     not ours. The landing is the one it would have been without it. */
  it("is the application when what was asked for may not be reached", () => {
    expect(afterSignIn(false, "?next=https://evil.example/pay", HERE)).toEqual({ to: "load", path: "/" });
    expect(afterSignIn(false, "?next=//evil.example", HERE)).toEqual({ to: "load", path: "/" });
    expect(afterSignIn(false, "?next=/..//evil.example", HERE)).toEqual({ to: "load", path: "/" });
  });
});
