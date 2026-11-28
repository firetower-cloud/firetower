/**
 * The workspace's name keeps its width.
 *
 * **It was the only thing in the row that could lose any.** `.whead` is a
 * flex row whose every other item — the agent's name, the repository chip's
 * wrapper, the controls at the right — is `flex: none`. The name carried
 * `min-width: 0` and no `flex` of its own, so it was both the only flexible
 * item and allowed to shrink to nothing: a narrow window squeezed it to a
 * single letter while a repository slug beside it kept its full width.
 *
 * Which is backwards. The name is what the screen is about, and a slug
 * truncates far more cheaply — so the name is fixed with a cap and the chip
 * is what gives.
 *
 * Asserted against the source. This is a flex-sizing rule: `styles.css` is
 * not loaded in these tests and a static render carries no layout, so there
 * is no rendered difference to assert on — the same reason the telemetry
 * pane's rule-consulting test reads its own file. The behaviour itself was
 * verified in Chrome against the built stylesheet, at a width that used to
 * clip the name.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const workbench = readFileSync(new URL("./Workbench.tsx", import.meta.url), "utf8");

/** The declarations inside one rule, by its exact selector. */
function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `${selector} must exist`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
}

describe("the workspace name in the title row", () => {
  const nm = rule(".whead .nm");

  /** **The assertion the old rule fails.** `min-width: 0` on a flexible item
      is permission to disappear, and it did. */
  it("is not allowed to shrink", () => {
    expect(nm).toContain("flex: none");
    expect(nm).not.toContain("min-width: 0");
  });

  /** A cap, so a very long name cannot push the controls off the end either.
      Past it the ellipsis takes over, which is why both still apply. */
  it("has a width it will not grow past, and ellipsises there", () => {
    expect(nm).toMatch(/max-width:\s*\d/);
    expect(nm).toContain("text-overflow: ellipsis");
    expect(nm).toContain("overflow: hidden");
  });

  /**
   * **And something else in the row has to give instead.**
   *
   * With the name fixed and every sibling `flex: none`, a narrow row would
   * simply overflow. The repository chip is the one that yields: it already
   * truncates its slug, and losing the tail of a slug costs less than losing
   * the name of the thing you are looking at.
   */
  it("leaves the repository chip as the thing that yields", () => {
    const chip = workbench.slice(workbench.indexOf('className="relative'));
    expect(chip.slice(0, 40)).toContain("min-w-0");
    expect(chip.slice(0, 40)).not.toContain("shrink-0");
  });
});
