/**
 * The title row shares out its width in a fixed order.
 *
 * **Two defects, one row, and the second was caused by the fix for the
 * first.**
 *
 * The name used to be the only item in `.whead` that could lose any width —
 * every sibling is `flex: none` — and it carried `min-width: 0`, so a narrow
 * window squeezed it to a single letter while a repository slug beside it
 * kept its full width. Backwards: the name is what the screen is about.
 *
 * Pinning the name with `flex: none` then broke something worse. Nothing else
 * in the row could yield either, so the repository chip kept its content
 * width and was drawn straight over *Another agent here*, *Who can access
 * it* and the terminal button — three controls that were unclickable while
 * still looking clickable. QA caught it with `elementFromPoint`; the suite
 * had nothing to say, which is why the hit-testing assertions below are the
 * ones that matter.
 *
 * The order is now: **the chip gives first, the name gives last, and the name
 * has a floor it never goes under.**
 *
 * Asserted against the source. These are flex-sizing rules: `styles.css` is
 * not loaded in these tests and a static render carries no layout, so there
 * is no rendered difference to assert on — the same reason the telemetry
 * pane's rule-consulting test reads its own file. The behaviour itself was
 * driven in Chrome against the built stylesheet from 1400px down to 420px,
 * hit-testing all three controls at every step.
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

describe("the workspace name", () => {
  const nm = rule(".whead .nm");

  /** **The assertion the original defect fails.** `min-width: 0` on the only
      flexible item in a row is permission to disappear, and it did. */
  it("has a floor it never shrinks under", () => {
    const floor = nm.match(/min-width:\s*([\d.]+)rem/);
    expect(floor, "a floor in rem").not.toBeNull();
    expect(Number(floor![1])).toBeGreaterThanOrEqual(8);
  });

  /** And a ceiling, so a very long name cannot push the controls off the end
      instead. Past it the ellipsis takes over, which is why both still apply. */
  it("has a width it will not grow past, and ellipsises there", () => {
    expect(nm).toMatch(/max-width:\s*\d/);
    expect(nm).toContain("text-overflow: ellipsis");
    expect(nm).toContain("overflow: hidden");
  });
});

describe("the repository chip, which is what yields", () => {
  /** The flex item is the wrapper. The first fix put `flex-shrink` on the
      chip inside it — a property on something that is not a flex item, which
      does exactly nothing, and the overlap survived it. */
  it("yields from the wrapper, which is the actual flex item", () => {
    const wrap = rule(".whead .repo");
    expect(wrap).toContain("min-width: 0");
    const shrink = wrap.match(/flex-shrink:\s*(\d+)/);
    expect(shrink, "an explicit shrink factor").not.toBeNull();
    // Far above the name's, so it is spent before the name gives a pixel.
    expect(Number(shrink![1])).toBeGreaterThan(100);
  });

  /**
   * **The assertion that keeps it off the controls.**
   *
   * A wrapper that shrinks while its child keeps its content width is the
   * overlap: the child simply overflows. Both caps live in one declaration
   * because they cannot live in two — the 15rem cap was a `max-w-[15rem]`
   * utility, and utilities are a later layer than components, so a
   * `max-width: 100%` written in CSS beside it was silently overridden.
   */
  it("is held inside the wrapper, and capped, in a single rule", () => {
    expect(rule(".whead .repo > .who")).toMatch(/max-width:\s*min\(\s*15rem\s*,\s*100%\s*\)/);
    expect(workbench, "the utility would win over the rule above").not.toContain("max-w-[15rem]");
  });

  it("is marked as the thing that yields", () => {
    expect(workbench).toContain('className="repo relative"');
  });

  /** Never on the wrapper: it is the positioning context for the repositories
      sheet, and clipping there would cut the sheet off. */
  it("does not clip the sheet it anchors", () => {
    expect(rule(".whead .repo")).not.toContain("overflow");
  });
});
