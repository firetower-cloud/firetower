/**
 * The generated files resolve to what their importers think they do.
 *
 * This exists because of a live defect in 0.13.0 rather than as a precaution.
 * `tokens.generated.js` held the Tailwind config and `tokens.generated.ts`
 * held the palette, and every resolver that puts `.js` before `.ts` — Metro's
 * default `sourceExts` and Vite's default `resolve.extensions` both do — gave
 * `import { color } from "~/design/tokens.generated"` the CommonJS Tailwind
 * config. It exports no `color`, so **every imperative colour in the shipped
 * app was `undefined`**: icon tints, the status-bar style, the pushed-screen
 * background. Against a near-black page, invisible.
 *
 * The generator refuses to emit two files with one basename now. This is the
 * other half: the import a component actually writes has to come back with the
 * palette on it, whatever the resolver decides.
 */
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as tokens from "~/design/tokens.generated";

describe("~/design/tokens.generated", () => {
  it("resolves to the palette and not to the Tailwind config", () => {
    // The bare specifier, exactly as 39 files write it.
    expect(tokens.light).toBeTypeOf("object");
    expect(tokens.dark).toBeTypeOf("object");
    expect(tokens.light.ground).toMatch(/^#[0-9a-f]{6}$/);
    // What the Tailwind config exports, and must not be what this is.
    expect(tokens).not.toHaveProperty("colors");
    expect(tokens).not.toHaveProperty("spacing");
  });

  it("carries the sizes and radii a component reads", () => {
    expect(tokens.size.read).toBe(17);
    expect(tokens.radius.lg).toBe(12);
  });

  it("has dropped `input`, which nothing here ever read", () => {
    expect(tokens.size).not.toHaveProperty("input");
  });
});

describe("src/design", () => {
  /**
   * No two modules in the directory may share a basename.
   *
   * `theme.ts` and `theme.tsx` hit the same trap during this build from the
   * other direction — `.ts` before `.tsx` — and the error it produces names
   * the missing export rather than the shadowing, which is a slow afternoon.
   * The pure half is `scheme.ts` for that reason.
   */
  it("has no two modules sharing a basename", () => {
    const stems = new Map<string, string[]>();
    for (const f of readdirSync(__dirname)) {
      if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f)) continue;
      const stem = f.replace(/\.[^.]+$/, "");
      stems.set(stem, [...(stems.get(stem) ?? []), f]);
    }
    const clashes = [...stems].filter(([, fs]) => fs.length > 1);
    expect(clashes, `shadowed: ${JSON.stringify(clashes)}`).toEqual([]);
  });
});
