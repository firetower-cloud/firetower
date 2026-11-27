/**
 * The one predicate that decides what a served page does not offer.
 *
 * The rule itself is one line, and testing a one-line rule directly is the
 * point rather than a formality: every surface in `installed-only.test.tsx`
 * reads *this*, so if the rule is ever given a second input — an origin, a
 * build flag, a query parameter — the pair of assertions below is where the
 * two clients stop being told apart by one observable, which is the property
 * worth protecting.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/* The shell, stood in for, as a live object so a test can make it answer
   either way. The same seam `update.test.ts` and `posters.test.tsx` use. */
const shell = vi.hoisted(() => ({ bridge: { native: true } }));
vi.mock("~/bridge", () => shell);

/* `advertisedKey` writes a shortcut the platform's way, so the platform is
   pinned rather than inherited from whatever machine the suite runs on. */
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  shell.bridge.native = true;
});

const fresh = async () => import("./installed-app");

describe("the rule", () => {
  it("is a shell and nothing else", async () => {
    const { installedAppFrom } = await fresh();
    expect(installedAppFrom({ shell: true })).toBe(true);
    expect(installedAppFrom({ shell: false })).toBe(false);
  });

  it("reads the one thing the bridge already answers", async () => {
    const { installedApp } = await fresh();
    expect(installedApp()).toBe(true);
    shell.bridge.native = false;
    expect(installedApp()).toBe(false);
  });
});

describe("a shortcut, where there is one to advertise", () => {
  it("writes it the platform's way inside the app", async () => {
    const { advertisedKey } = await fresh();
    expect(advertisedKey("K")).toBe("⌘K");
    expect(advertisedKey(",")).toBe("⌘,");
  });

  it("says nothing at all in a browser", async () => {
    shell.bridge.native = false;
    const { advertisedKey } = await fresh();
    expect(advertisedKey("K")).toBeUndefined();
    expect(advertisedKey(",")).toBeUndefined();
  });

  /* **`undefined`, not the empty string.** Every reader of this hands it to a
     `hint`, a `shortcut` or a `title` that is optional and draws the bare
     label when it is absent — `Glyph`, `IconButton`, `RailButton`,
     `ContextMenu`. An empty string is truthy to none of them but is a value
     to `??`, and the difference is a trailing double space in half a dozen
     tooltips. */
  it("is absent rather than empty, which is what the hints take", async () => {
    shell.bridge.native = false;
    const { advertisedKey } = await fresh();
    expect(advertisedKey("K") ?? "nothing").toBe("nothing");
  });

  /* Off a Mac the window's modifier is Ctrl and is written out — which is
     `platform.ts`'s decision and is unchanged by any of this. Here so that a
     reader can see the two questions are independent: this one is about
     whether there is a shortcut, that one is about what it is called. */
  it("leaves what a modifier is called to the platform", async () => {
    vi.stubGlobal("navigator", { platform: "Win32" });
    const { advertisedKey } = await fresh();
    expect(advertisedKey("K")).toBe("Ctrl+K");
  });
});
