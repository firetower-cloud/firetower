/**
 * The button on the replace-a-password screen has to open a page that can
 * actually replace a password.
 *
 * It opened the bare root, and the bare root moved. Serving the application at
 * `/` took that path off the administration site, so the button opened the app
 * that had just explained it does not carry this screen — which drew the same
 * gate again, in the shell as well as in a browser. Nothing errored. Somebody
 * with a temporary password simply could not get in.
 *
 * So the target is pinned here rather than left to the next person who moves a
 * route to discover from a user who is locked out. Two halves, because the
 * defect had two: the path itself, and that both of this screen's buttons use
 * it — the one met at the door and the one met mid-session when an
 * administrator has reset a password under a running app.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { passwordPage } from "./ReplacePassword";

const source = readFileSync(new URL("./ReplacePassword.tsx", import.meta.url), "utf8");

describe("where a password is replaced", () => {
  it("is a page on the control plane that is not the application", () => {
    expect(passwordPage("https://ft.westlabs.dev")).toBe("https://ft.westlabs.dev/login");
    expect(passwordPage("http://127.0.0.1:4400")).toBe("http://127.0.0.1:4400/login");
  });

  /* The regression in its own words. `/` and `/index.html` are the
     application's; `/login` is the administration site's and is the one route
     of the three that answers whether or not there is a session. */
  it("is not the root, which is the application and would draw this screen again", () => {
    const opened = passwordPage("https://ft.westlabs.dev");
    expect(opened).not.toBe("https://ft.westlabs.dev");
    expect(opened).not.toBe("https://ft.westlabs.dev/");
    expect(opened).not.toBe("https://ft.westlabs.dev/index.html");
    expect(new URL(opened).pathname).toBe("/login");
  });

  /* Asserted against the source, because reaching either button needs a
     sign-in and these tests render to a string. The invariant is cheap and it
     is the one that was broken: *both* ways out go through the same rule. */
  it("is where both of this screen's buttons point", () => {
    // Every call, however its argument is written, and then how many of them
    // go through the rule. Counting only the correct shape would pass a file
    // that had grown a third button straight back to the root.
    const calls = [...source.matchAll(/openExternal\(/g)].length;
    const routed = [...source.matchAll(/openExternal\(passwordPage\(origin\)\)/g)].length;
    expect(calls).toBe(2);
    expect(routed).toBe(calls);
  });

  it("still carries no password form of its own, which is the whole reason it sends you away", () => {
    // The point of this screen is that the form lives in exactly one place.
    // A password field appearing here would be the second copy its own
    // documentation argues against.
    expect(source).not.toMatch(/type="password"/);
  });
});
