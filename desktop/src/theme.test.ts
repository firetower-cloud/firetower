import { describe, expect, test } from "vitest";
import { resolve } from "./theme";

describe("which theme a choice means", () => {
  test("an explicit choice ignores the machine", () => {
    expect(resolve("light", false)).toBe("light");
    expect(resolve("dark", true)).toBe("dark");
  });

  /* The default, and the reason `system` is a third value rather than the
     absence of one: "follow the Mac" is a choice somebody made, and it has to
     survive the Mac changing its mind. */
  test("system follows the machine", () => {
    expect(resolve("system", true)).toBe("light");
    expect(resolve("system", false)).toBe("dark");
  });

  /* Nothing to ask — a browser with no `prefers-color-scheme` at all, which
     is what `matchMedia` being absent looks like. Dark is the sheet's own
     default, so falling back to it is the one answer that needs no override. */
  test("and falls to dark when the machine says nothing", () => {
    expect(resolve("system", false)).toBe("dark");
  });
});
