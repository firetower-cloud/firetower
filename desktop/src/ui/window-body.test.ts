/**
 * What the window draws under its title bar, and the one answer it must never
 * give.
 *
 * `Window` draws **nothing** for a server it cannot find in the list it is
 * holding. That is right with no servers — there is a door for that — and it
 * is a bug every other time: a title bar over an empty window, with no way
 * back but a relaunch. QA measured it at 21 characters of DOM, permanent.
 *
 * It was reachable, and by the ordinary path rather than an exotic one. The
 * registry announces a new row before anything has named it — `remember()`
 * fires its watchers and `Connect` hands the server id up afterwards — so
 * every sign-in passed through a moment where the window held a list
 * containing a server and a choice naming none of them. An effect corrected
 * it afterwards, which made the blank a flicker when the effect ran and a
 * state when it did not.
 *
 * So the choice is resolved during the render that needs it, and these are
 * the rules that say so.
 */
import { describe, expect, it } from "vitest";
import { bodyFor, serverOn } from "~/App";

const row = (serverId: string, token = "tok") => ({ serverId, token });

describe("which server the window is on", () => {
  it("is the one asked for, while it is still there", () => {
    expect(serverOn([row("a"), row("b")], "b")).toBe("b");
  });

  it("falls back to the first when the choice names nothing", () => {
    // The sign-in case: the row has arrived, the choice has not caught up.
    expect(serverOn([row("a")], null)).toBe("a");
    // And the forgotten-server case.
    expect(serverOn([row("a")], "gone")).toBe("a");
  });

  it("is nothing only when there is nothing", () => {
    expect(serverOn([], "a")).toBe(null);
    expect(serverOn([], null)).toBe(null);
  });
});

describe("what the window draws", () => {
  it("never draws nothing while it holds a server", () => {
    /* The assertion this file exists for. Every combination of a non-empty
       list and any choice at all, including the ones that used to blank. */
    const lists = [[row("a")], [row("a", "")], [row("a"), row("b", "")], [row("a", ""), row("b")]];
    const asked = [null, "a", "b", "gone"];
    const paths = ["/", "/artifacts", "/connect", "/configuration"];
    for (const real of lists) {
      for (const which of asked) {
        for (const path of paths) {
          for (const installed of [true, false]) {
            expect(bodyFor(real, serverOn(real, which), path, installed)).not.toBe("nothing");
          }
        }
      }
    }
  });

  it("draws that server's door when its token has gone", () => {
    const real = [row("a", "")];
    expect(bodyFor(real, serverOn(real, "a"), "/", true)).toBe("door");
    // Including when the choice has not caught up, which is the sign-in case.
    expect(bodyFor(real, serverOn(real, null), "/", true)).toBe("door");
  });

  it("draws the app once the token has arrived", () => {
    const real = [row("a")];
    expect(bodyFor(real, serverOn(real, null), "/", true)).toBe("app");
  });

  it("draws the door for no servers, and for an asked-for connection", () => {
    expect(bodyFor([], null, "/", true)).toBe("connect");
    expect(bodyFor([row("a")], "a", "/connect", true)).toBe("connect");
  });

  /**
   * **`/connect` is the installed app's address and nothing else's.**
   *
   * A page a control plane served can reach that control plane and no other,
   * so the screen for naming a *different* one has nothing to do there — and
   * the address was the last way to it once the switcher, *Connect a
   * Firetower…* and the palette's command had gone. Hand-typed it used to
   * draw, and attaching a second server from it left somebody with no
   * switcher to reach it and no *Forget* to undo it.
   *
   * It falls through to the app, which `Routes.tsx` draws as Home for every
   * address it does not recognise. The pair is the point: the Tauri build is
   * unchanged, which is where `/connect` is a real screen somebody asked for.
   */
  it("offers no connect screen to a served page, and still does inside the app", () => {
    const real = [row("a")];
    expect(bodyFor(real, "a", "/connect", true)).toBe("connect");
    expect(bodyFor(real, "a", "/connect", false)).toBe("app");
  });

  /* The first run is not the same question and must survive it: with nothing
     in the registry there is a sign-in to draw whoever is asking, and
     `Connect` answers the *where* half from the origin by itself. */
  it("still draws the first sign-in in a browser, with no servers at all", () => {
    expect(bodyFor([], null, "/", false)).toBe("connect");
    expect(bodyFor([], null, "/connect", false)).toBe("connect");
  });
});
