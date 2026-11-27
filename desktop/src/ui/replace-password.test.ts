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
 *
 * **And there were two screens, not one.** The first fix pinned this file and
 * left `Account.tsx` opening the bare origin, which is the same control with
 * the same destination and the same way of failing — a button that looks like
 * a way out of the app and lands you back inside it. Fixing one of two and
 * testing the one you fixed is how a defect survives its own regression test,
 * so the sweep below is over every screen rather than over this one.
 *
 * **The target moved once more, and for the same reason the sweep exists.**
 * It was `/login`, chosen by reasoning about the duress screen alone: signed
 * out and holding a temporary password, `/login` routes to `/setup` and the
 * password gets replaced. The other caller is the voluntary change, where
 * nothing is owed — so `/login` signed those people in and returned them to
 * the application, and the one form in the product that lets somebody change a
 * password they still know was unreachable from the only control that offers
 * it. `/account` is that form. Pinned below as the path, not merely as
 * "not the root", because "not the root" was satisfied by the target that
 * could not work.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { passwordPage } from "./ReplacePassword";

const source = readFileSync(new URL("./ReplacePassword.tsx", import.meta.url), "utf8");

/** Every `.ts`/`.tsx` under `src`, the walk `reuse.test.ts` established. */
function sources(): { path: string; text: string }[] {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "generated") walk(path);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push({ path: `src/${path.slice(root.length).split(sep).join("/")}`, text: readFileSync(path, "utf8") });
      }
    }
  };
  walk(root);
  return out;
}

describe("where a password is replaced", () => {
  it("is the form on the control plane, not a door in front of it", () => {
    expect(passwordPage("https://ft.westlabs.dev")).toBe("https://ft.westlabs.dev/account");
    expect(passwordPage("http://127.0.0.1:4400")).toBe("http://127.0.0.1:4400/account");
  });

  /* The second regression in its own words. `/login` is a sign-in screen and
     sends you on by what the *server* says is outstanding, which for somebody
     changing a password voluntarily is nothing — so it returns them to the
     application. Only `/account` carries three password fields. */
  it("is not the sign-in screen, which sends a voluntary change back to the app", () => {
    const opened = passwordPage("https://ft.westlabs.dev");
    expect(new URL(opened).pathname).not.toBe("/login");
    expect(new URL(opened).pathname).not.toBe("/setup");
  });

  /* The first regression in its own words. `/` and `/index.html` are the
     application's; `/account` is the administration site's. */
  it("is not the root, which is the application and would draw this screen again", () => {
    const opened = passwordPage("https://ft.westlabs.dev");
    expect(opened).not.toBe("https://ft.westlabs.dev");
    expect(opened).not.toBe("https://ft.westlabs.dev/");
    expect(opened).not.toBe("https://ft.westlabs.dev/index.html");
    expect(new URL(opened).pathname).toBe("/account");
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

  /**
   * **The sweep, which is what would have caught the second screen.**
   *
   * `origin` is this app's name for *the Firetower this window is signed in
   * to*, and since the renderer took `/` that address is the application
   * itself. So handing it to `openExternal` is never right: whatever the
   * caller wanted, it is a path on the control plane and not the root. Asked
   * of every screen rather than of the two known ones, because the question
   * is "is there a third" and a list of two cannot answer it.
   */
  it("is never the bare origin, on any screen", () => {
    const offenders = sources()
      .filter((f) => /openExternal\(\s*origin\s*\)/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  /* The two screens that send somebody to this Firetower's own interface, by
     name — so that a third arriving is a decision rather than an accident.
     Every other `openExternal` in the app points at somewhere else entirely:
     a pull request, an artifact, a provider's settings page, an agent's
     device-code page. */
  it("is reached through the one rule, from both of the screens that send you there", () => {
    const sending = sources()
      .filter((f) => /passwordPage\(/.test(f.text))
      .map((f) => f.path)
      .sort();
    expect(sending).toEqual(["src/ui/Account.tsx", "src/ui/ReplacePassword.tsx"]);
    const account = sources().find((f) => f.path === "src/ui/Account.tsx")!.text;
    expect(account).toContain("openExternal(passwordPage(origin))");
  });

  it("still carries no password form of its own, which is the whole reason it sends you away", () => {
    // The point of this screen is that the form lives in exactly one place.
    // A password field appearing here would be the second copy its own
    // documentation argues against.
    expect(source).not.toMatch(/type="password"/);
  });
});
