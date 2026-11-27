/**
 * The code, and the one thing about it a theme does not get to decide.
 *
 * **A camera reads dark-on-light.** An inverted code — light modules on a dark
 * plate — is outside ISO/IEC 18004: an iPhone decodes one anyway and a good
 * many Android scanners do not. The web client's copy of this component drew
 * exactly that in light, because it bound the plate to `--color-bone` and the
 * modules to `--color-ground`: right in dark, and reversed in light, where
 * bone is `#161617` and ground is `#f2f2f3`.
 *
 * ## Why this test reads the stylesheets
 *
 * The colours are not in the markup — binding them there is what went wrong —
 * so asserting on markup could only check that the elements still wear
 * `.plate` and `.ink`, which the bug also did. The question is *what those
 * resolve to under each theme*, so the sheets are parsed and the tokens
 * resolved the way the renderer resolves them: `globals.css`'s `@theme` as
 * the dark default, `styles.css`'s `[data-theme="dark"]` over it, and
 * `globals.css`'s light branch plus the desk's own light overrides for light.
 *
 * Then one rule, in both themes and in both clients: **the plate is lighter
 * than the modules.** That is the assertion the shipped bug fails, and the
 * resolver is proved against a hand-written inverted pair below before it is
 * pointed at the real ones — a guard that cannot fail is not a guard.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { QrCode, codeWidth } from "./QrCode";

const at = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const GLOBALS = at("../../globals.css");
const STYLES = at("../../styles.css");
const WEB_QR = at("../../../../web/components/ui/QrCode.tsx");

/* ══ resolving a token the way the renderer does ═══════════════════════ */

/** Every `--name: value` in the first block a selector opens. */
function block(css: string, selector: string): Record<string, string> {
  const at = css.indexOf(selector);
  if (at < 0) return {};
  const open = css.indexOf("{", at);
  let depth = 0;
  let end = open;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  const out: Record<string, string> = {};
  for (const m of css.slice(open, end).matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) out[m[1]] = m[2].trim();
  return out;
}

/**
 * The custom properties in force under one theme.
 *
 * Order is the cascade's: the shared `@theme` is the dark default, the desk
 * re-derives part of dark over it, and light is the shared light branch plus
 * the desk's three native overrides.
 */
const under = (theme: "dark" | "light"): Record<string, string> => ({
  ...block(GLOBALS, "@theme"),
  ...(theme === "dark"
    ? block(STYLES, '[data-theme="dark"]')
    : { ...block(GLOBALS, '[data-theme="light"]'), ...block(STYLES, '[data-theme="light"]') }),
});

/** `var(--color-bone)` → `#f4f4f5`, following however many hops it takes. */
function resolve(value: string, vars: Record<string, string>): string {
  for (let hop = 0; hop < 8; hop++) {
    const ref = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value.trim());
    if (!ref) return value.trim();
    value = vars[ref[1]] ?? "";
  }
  throw new Error(`${value} never resolved`);
}

/* ══ how light a colour is ═════════════════════════════════════════════ */

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a hex colour: ${hex}`);
  const channel = (at: number) => {
    const c = parseInt(m[1].slice(at, at + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * **The rule.** A scanner wants roughly a 40% reflectance difference; this is
 * stricter, and the real pairs clear it by a long way in both themes. The part
 * that matters is the *order* — which of the two is the light one.
 */
function readsAsACode({ plate, ink }: { plate: string; ink: string }) {
  return { plateIsLighter: luminance(plate) > luminance(ink), contrast: contrast(plate, ink) };
}

/* ══ the checker, before it is trusted with the real pairs ═════════════ */

describe("the rule, proved against a pair that should fail it", () => {
  it("passes a dark code on a light plate", () => {
    expect(readsAsACode({ plate: "#ffffff", ink: "#161617" }).plateIsLighter).toBe(true);
  });

  /* This is the shipped pair, in light: `--color-bone` on the plate and
     `--color-ground` in the modules. If the rule below cannot fail here it
     cannot catch anything. */
  it("fails the inversion the web client ships today", () => {
    const light = under("light");
    const shipped = {
      plate: resolve("var(--color-bone)", light),
      ink: resolve("var(--color-ground)", light),
    };
    expect(shipped.plate).toBe("#161617");
    expect(shipped.ink).toBe("#f2f2f3");
    expect(readsAsACode(shipped).plateIsLighter).toBe(false);
  });

  it("reads a resolver chain rather than a literal", () => {
    expect(resolve("var(--color-ground)", under("dark"))).toBe("#1d1d1e");
    expect(resolve("var(--color-ground)", under("light"))).toBe("#f2f2f3");
  });
});

/* ══ the desk ══════════════════════════════════════════════════════════ */

describe("the code the desk draws", () => {
  const pair = (theme: "dark" | "light") => {
    const vars = under(theme);
    const qr =
      theme === "light"
        ? { ...block(STYLES, ".qr {"), ...block(STYLES, '[data-theme="light"] .qr') }
        : block(STYLES, ".qr {");
    return { plate: resolve(qr["--qr-plate"], vars), ink: resolve(qr["--qr-ink"], vars) };
  };

  it("binds the pair in the stylesheet at all, which is the shape of the fix", () => {
    expect(block(STYLES, ".qr {")).toMatchObject({
      "--qr-plate": "var(--color-bone)",
      "--qr-ink": "var(--color-ground)",
    });
    expect(block(STYLES, '[data-theme="light"] .qr')).toMatchObject({
      "--qr-plate": "var(--color-panel)",
      "--qr-ink": "var(--color-bone)",
    });
  });

  it.each(["dark", "light"] as const)("is dark-on-light in %s", (theme) => {
    const read = readsAsACode(pair(theme));
    expect(read.plateIsLighter).toBe(true);
    expect(read.contrast).toBeGreaterThan(10);
  });

  /* **The assertion the shipped bug fails.** Light is where it fails, light is
     what the user photographed, and light is the demo. */
  it("draws a light plate and dark modules in light theme", () => {
    expect(pair("light")).toEqual({ plate: "#ffffff", ink: "#161617" });
  });

  /* Not pure white in dark on purpose: a 188px #ffffff square in a dark
     window is a glare source, and `--color-bone` is the softer white the rest
     of the dark theme is built on. */
  it("softens the plate in dark rather than reaching for white", () => {
    const { plate } = pair("dark");
    expect(plate).toBe(resolve("var(--color-bone)", under("dark")));
    expect(plate).not.toBe("#ffffff");
  });

  /* The two rules above govern nothing unless the markup wears the classes
     they are written against. */
  it("wears the classes those rules are written against", () => {
    const svg = renderToStaticMarkup(<QrCode value="https://example.test" label="A code" />);
    expect(svg).toContain('class="qr ');
    expect(svg).toContain('class="plate"');
    expect(svg).toContain('class="ink"');
    expect(svg).toContain('class="ink-s"');
    /* And names no colour of its own, which is what moving the pair to CSS
       was for. */
    expect(svg).not.toMatch(/fill="(?!none)/);
    expect(svg).not.toContain("stroke=");
  });
});

/* ══ the web client, which is where it is live today ═══════════════════ */

/**
 * `web/` has no stylesheet of its own — `globals.css` is byte-shared with the
 * desk and `just check-style` diffs it — so the same pair is carried there as
 * Tailwind utilities with a light variant. Read out of the source and put
 * through the same rule.
 */
describe("the code the web client draws, for as long as /index is served", () => {
  /**
   * The three paints, in the order the component writes them: the plate's
   * fill, the modules' fill, and the corner rings' stroke. Each appears twice
   * — once bare, once behind the light variant — and the pair below is read
   * out of whichever of the two is in force.
   */
  const paints = (theme: "dark" | "light") => {
    const found: { light: boolean; token: string }[] = [];
    for (const m of WEB_QR.matchAll(/(\[\[data-theme=light\]_&\]:)?(?:fill|stroke)-([a-z-]+)/g)) {
      found.push({ light: !!m[1], token: m[2] });
    }
    const vars = under(theme);
    return found.filter((p) => p.light === (theme === "light")).map((p) => resolve(`var(--color-${p.token})`, vars));
  };

  it("paints exactly three things, and the same two in each theme", () => {
    /* If this drifts, every assertion below is reading the wrong strings —
       so it is checked rather than assumed. */
    const names = [...WEB_QR.matchAll(/(\[\[data-theme=light\]_&\]:)?(fill|stroke)-([a-z-]+)/g)].map(
      (m) => `${m[1] ? "light:" : ""}${m[2]}-${m[3]}`,
    );
    expect(names).toEqual([
      "fill-bone",
      "light:fill-panel",
      "fill-ground",
      "light:fill-bone",
      "stroke-ground",
      "light:stroke-bone",
    ]);
  });

  it.each(["dark", "light"] as const)("is dark-on-light in %s", (theme) => {
    const [plate, modules, rings] = paints(theme);
    /* The rings are stroked rather than filled and they are part of the code:
       a ring left in the old colour is a code with three inverted corners. */
    expect(rings).toBe(modules);
    const read = readsAsACode({ plate, ink: modules });
    expect(read.plateIsLighter).toBe(true);
    expect(read.contrast).toBeGreaterThan(10);
  });

  it("draws a light plate and dark modules in light theme", () => {
    const [plate, modules] = paints("light");
    expect({ plate, modules }).toEqual({ plate: "#ffffff", modules: "#161617" });
  });

  it("no longer paints either colour with a token whose role flips", () => {
    /* The literal shape of the defect: one `var()` for both themes. */
    expect(WEB_QR).not.toContain('fill="var(--color-bone)"');
    expect(WEB_QR).not.toContain('fill="var(--color-ground)"');
    expect(WEB_QR).not.toContain('stroke="var(--color-ground)"');
  });
});

/* ══ the floor, which is per module and not per code ═══════════════════ */

describe("the size it is drawn at", () => {
  it("is this value's own floor when nothing else is asked for", () => {
    const value = "https://example.test/a";
    const svg = renderToStaticMarkup(<QrCode value={value} label="A code" />);
    expect(svg).toContain(`width="${codeWidth(value)}"`);
  });

  /* A caller with two codes to keep the same size may widen one. It may not
     narrow one: a box too small for the payload in it is the failure the
     arithmetic exists to prevent. */
  it("takes a wider box from its caller", () => {
    const value = "https://example.test/a";
    const svg = renderToStaticMarkup(<QrCode value={value} label="A code" width={400} />);
    expect(svg).toContain('width="400"');
  });

  it("refuses a box below the floor rather than drawing a code nothing can read", () => {
    const value = "https://example.test/a";
    const svg = renderToStaticMarkup(<QrCode value={value} label="A code" width={40} />);
    expect(svg).toContain(`width="${codeWidth(value)}"`);
    expect(svg).not.toContain('width="40"');
  });
});
