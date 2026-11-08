import { describe, expect, test } from "vitest";
import { isGlobalMod, isLocalMod, isMac } from "./platform";

/**
 * The two modifiers, and the one property that matters about them.
 *
 * ⌘1–⌘6 are the rail's six destinations; ⌃1–⌃3 are the inspector's tabs
 * inside one workspace. They are different gestures and they have to stay
 * different — the window handler used to accept `metaKey || ctrlKey`, so on a
 * Mac ⌃2 reached the rail first and navigated away instead of switching a tab.
 */
const press = (over: Partial<Record<"ctrlKey" | "altKey" | "metaKey", boolean>>) => ({
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...over,
});

describe("the global and the local modifier", () => {
  test("never both, for any combination of the three keys", () => {
    for (const ctrlKey of [false, true])
      for (const altKey of [false, true])
        for (const metaKey of [false, true]) {
          const e = { ctrlKey, altKey, metaKey };
          expect(isGlobalMod(e) && isLocalMod(e)).toBe(false);
        }
  });

  test("neither fires with no modifier at all", () => {
    expect(isGlobalMod(press({}))).toBe(false);
    expect(isLocalMod(press({}))).toBe(false);
  });

  /* On a Mac ⌘ is the window's and ⌃ is one pane's. Everywhere else Ctrl
     already *is* the window's, so the local one has to be Alt. */
  test("each is the key its platform means", () => {
    expect(isGlobalMod(press(isMac ? { metaKey: true } : { ctrlKey: true }))).toBe(true);
    expect(isLocalMod(press(isMac ? { ctrlKey: true } : { altKey: true }))).toBe(true);
  });

  test("and the other platform's key is not it", () => {
    expect(isGlobalMod(press(isMac ? { ctrlKey: true } : { metaKey: true }))).toBe(false);
    expect(isLocalMod(press(isMac ? { altKey: true } : { ctrlKey: true }))).toBe(false);
  });

  /* Alt composes characters on a Mac and is the local modifier off one, so a
     chord carrying it is never the global gesture. */
  test("alt is never the global one", () => {
    expect(isGlobalMod(press({ metaKey: true, altKey: true }))).toBe(false);
    expect(isGlobalMod(press({ ctrlKey: true, altKey: true }))).toBe(false);
  });
});
