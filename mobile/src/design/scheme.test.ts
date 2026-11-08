/**
 * The theme choice, which is three settings and not two.
 *
 * `resolve` is the whole of the logic. The interesting cases are the ones
 * where the choice and the system disagree, and the one where the system has
 * not answered yet — because that frame gets drawn either way.
 */
import { describe, expect, it } from "vitest";
import { CHOICES, resolve } from "~/design/scheme";
import { dark, light } from "~/design/tokens.generated";

describe("resolve", () => {
  it("follows the system when the choice is system", () => {
    expect(resolve("system", "light")).toBe("light");
    expect(resolve("system", "dark")).toBe("dark");
  });

  it("overrides the system when the choice is explicit", () => {
    expect(resolve("light", "dark")).toBe("light");
    expect(resolve("dark", "light")).toBe("dark");
  });

  it("draws light before the system has answered, because light is the design", () => {
    expect(resolve("system", null)).toBe("light");
    expect(resolve("system", undefined)).toBe("light");
  });

  it("still honours an explicit choice with no system answer", () => {
    expect(resolve("dark", null)).toBe("dark");
    expect(resolve("light", null)).toBe("light");
  });

  it("offers System, Light and Dark in the platform's order", () => {
    expect(CHOICES.map((c) => c.id)).toEqual(["system", "light", "dark"]);
  });
});

/**
 * The finding the designer caught, asserted on the values rather than on a
 * screenshot.
 *
 * Five surfaces — the composer, an artifact card, a sheet, a popover, the peek
 * — were filled with `--color-ground` and separated by a shadow. In dark the
 * shadow renders nothing over a 0.337% luminance page, so every one of them
 * measured ΔE 0.00 against it. They take `--color-float` now, and in dark that
 * has to be a different colour from the page or the fix is cosmetic.
 *
 * A screenshot cannot catch this: in dark the regression is two near-blacks
 * that look identical in a PNG and measure identically in a pixel sampler.
 */
describe("the float surface is not the page", () => {
  const Y = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const [r, g, b] = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };

  it("lifts off the page in dark, where a shadow renders nothing", () => {
    expect(dark.float).not.toBe(dark.ground);
    // A ΔE alone is not enough at the bottom of the range; check the ratio of
    // the luminances too, which is what says how hard the edge will read.
    // **The ratio of luminances, not the contrast ratio** — the two are
    // different numbers and the PR called 1.184 a luminance ratio for a
    // while. Here: 3.92x the luminance, a 1.184:1 contrast ratio.
    expect(Y(dark.float) / Y(dark.ground)).toBeGreaterThan(3);
    const contrast = (Y(dark.float) + 0.05) / (Y(dark.ground) + 0.05);
    expect(contrast).toBeGreaterThan(1.1);
  });

  it("is the page's own white in light, where the shadow does the work", () => {
    expect(light.float).toBe("#ffffff");
    expect(light.float).toBe(light.ground);
  });

  it("keeps the dark page at L* 3.0 rather than following the desk to #1d1d1e", () => {
    // One page, usually OLED, and iOS's own systemBackground in dark is pure
    // black. The desk's complaint was chrome beside content, which a
    // full-bleed phone has not got.
    expect(dark.ground).toBe("#0b0b0c");
  });
});

/** Every name resolves in both branches, or a screen renders a transparent box. */
describe("both branches", () => {
  it("carry the same names", () => {
    expect(Object.keys(light).sort()).toEqual(Object.keys(dark).sort());
  });

  it("carry no empty value", () => {
    for (const [name, value] of [...Object.entries(light), ...Object.entries(dark)]) {
      expect(value, name).toMatch(/\S/);
    }
  });
});
