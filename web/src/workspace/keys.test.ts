import { describe, expect, it } from "vitest";
import { isFindFile } from "./keys";

/**
 * A `keydown` as the browser would give it, with the defaults a plain press has.
 *
 * `code` is the key's place on the board and `key` is what that place produces
 * under the current layout. They are the same thing on a US keyboard and are
 * not on most others, which is the whole reason this predicate reads both.
 */
const press = (over: Partial<KeyboardEvent>): KeyboardEvent =>
  ({
    key: "p",
    code: "KeyP",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  }) as KeyboardEvent;

describe("⌘P means find a file", () => {
  it("takes the key on either modifier", () => {
    expect(isFindFile(press({ metaKey: true }))).toBe(true);
    expect(isFindFile(press({ ctrlKey: true }))).toBe(true);
  });

  it("leaves a bare P to whoever is typing", () => {
    expect(isFindFile(press({}))).toBe(false);
  });

  it("is the physical key, not the letter it happens to make", () => {
    // AZERTY, Dvorak, Colemak: the P people press is the P people press, and
    // the character underneath it is not always a `p`.
    expect(isFindFile(press({ metaKey: true, key: "r", code: "KeyP" }))).toBe(true);
    // And a layout that reports no useful `code` still works off the letter.
    expect(isFindFile(press({ metaKey: true, key: "P", code: "" }))).toBe(true);
  });

  it("leaves ⇧⌘P alone, which is where a command palette goes", () => {
    expect(isFindFile(press({ metaKey: true, shiftKey: true }))).toBe(false);
  });

  it("leaves ⌥⌘P alone", () => {
    expect(isFindFile(press({ metaKey: true, altKey: true }))).toBe(false);
  });

  it("does not answer for its neighbours on the board", () => {
    expect(isFindFile(press({ metaKey: true, key: "o", code: "KeyO" }))).toBe(false);
    expect(isFindFile(press({ metaKey: true, key: "[", code: "BracketLeft" }))).toBe(false);
  });
});
