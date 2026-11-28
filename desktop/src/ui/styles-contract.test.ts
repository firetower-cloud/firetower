/**
 * The rules the screens are drawn with are still in the sheet.
 *
 * **A stylesheet is the one source in this app with no compiler behind it.**
 * `tsc` does not read `styles.css`, the 1777 unit tests do not read it, and
 * `vite build` reads it only far enough to parse — so a rule that disappears
 * takes a screen's design with it and nothing goes red. That is not a
 * hypothetical: merge `65c9c22b` resolved a conflict in this file by
 * reconstruction and dropped twenty-four selectors' worth of rules on the
 * floor. Discover on Skills & MCP rendered as a vertical stack of unstyled
 * text with strikethrough through every description, the skill detail page's
 * Connect button wrapped onto two lines, and the branch was green.
 *
 * So the selectors the components depend on are named here, by screen, and
 * asserted to exist. The list is the artifact: it is what a reconstruction has
 * to satisfy, and it is checked in both directions — a name that no component
 * references any more fails too, so it shrinks deliberately rather than
 * rotting.
 *
 * Three things beyond mere existence, each a way this file has actually
 * broken:
 *
 * - **Balanced braces.** A previous unbalanced-brace break here passed `tsc`,
 *   the whole unit suite and `check-style` while leaving a rule unclosed.
 * - **No nested layer.** `482385b6` found `@layer components` opened inside
 *   another that had not closed. The braces balanced and the file parsed; what
 *   changed was the cascade, because a nested layer loses to an equal-specificity
 *   rule in the layer containing it. Every `@layer` here is top-level.
 * - **The declarations that carry the symptom**, not just the selector. `.act`
 *   without `white-space: nowrap` is the two-line Connect button, and a
 *   selector-only check would call that restored.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SHEET = new URL("../styles.css", import.meta.url);
const css = readFileSync(SHEET, "utf8");

/** Comments out, newlines kept, so reported positions stay honest. */
const blanked = (s: string) => s.replace(/[^\n]/g, " ");
const bare = css
  .replace(/\/\*[\s\S]*?\*\//g, blanked)
  .replace(/"(?:[^"\\\n]|\\.)*"/g, blanked)
  .replace(/'(?:[^'\\\n]|\\.)*'/g, blanked);

/**
 * One linear pass over the sheet: every rule, its selectors, its declarations,
 * and whether a layer encloses it. A regex over a file this size backtracks
 * for seconds; this is a scanner.
 */
type Rule = { selectors: string[]; declarations: string; layered: boolean };

const rules: Rule[] = [];
const nestedLayers: string[] = [];
let unbalanced = false;

{
  type Frame = { at: boolean; layer: boolean; start: number; selectors: string[] };
  const open: Frame[] = [];
  let buf = "";
  for (let i = 0; i < bare.length; i++) {
    const ch = bare[i];
    if (ch === "{") {
      const prelude = buf.trim().replace(/\s+/g, " ");
      buf = "";
      const at = prelude.startsWith("@");
      const layer = /^@layer\b/.test(prelude);
      if (layer && open.length > 0) nestedLayers.push(prelude);
      open.push({
        at,
        layer,
        start: i + 1,
        selectors: at ? [] : prelude.split(",").map((p) => p.trim().replace(/\s+/g, " ")),
      });
    } else if (ch === "}") {
      const frame = open.pop();
      buf = "";
      if (!frame) {
        unbalanced = true;
        continue;
      }
      if (!frame.at) {
        rules.push({
          selectors: frame.selectors,
          declarations: bare.slice(frame.start, i),
          layered: open.some((f) => f.layer),
        });
      }
    } else if (ch === ";") {
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (open.length > 0) unbalanced = true;
}

/** Every class selector the sheet defines, one entry per comma-separated part. */
const defined = new Set<string>();
for (const rule of rules) {
  for (const sel of rule.selectors) if (sel.startsWith(".")) defined.add(sel);
}

/** The declarations of the first rule whose selector list contains `sel`. */
function declarations(sel: string): string {
  return rules.find((r) => r.selectors.includes(sel))?.declarations ?? "";
}

/**
 * Discover, on Skills & MCP — the grid and its rows.
 *
 * `.offer .tx s` and `.offer .tx u` are the reason the unstyled page had a
 * line through it: they are `<s>` and `<u>` used as the two sub-lines of a
 * row, and `text-decoration: none` is what makes them typography rather than
 * strikethrough and underline.
 */
const DISCOVER = {
  file: "./config/Library.tsx",
  token: "offer",
  rules: [
    ".offers",
    ".offer",
    ".offer:hover",
    ".offer .g",
    ".offer .tx",
    ".offer .tx b",
    ".offer .tx s",
    ".offer .tx u",
    ".offer > span:last-child",
  ],
};

/**
 * One shape for the one action, wherever it is drawn — `config/Take.tsx` picks
 * the words, `ServerInside.tsx` and `profile/ProfilePlugins.tsx` draw it.
 *
 * The `.r`-scoped halves are the ones a reconstruction misses: they are `.act`
 * variants written under `.r`, so a search for blocks *starting* `.act` does
 * not find them, and without them the hover-reveal is half a component — the
 * control either never appears or never hides.
 */
const TAKE = {
  file: "./config/Take.tsx",
  token: "act",
  rules: [
    ".act",
    ".act:hover",
    ".act[disabled]",
    ".act-said",
    ".act-done",
    ".act-page",
    ".offer .act",
    ".r .act",
    ".offer:hover .act",
    ".offer:focus-within .act",
    ".r:hover .act",
    ".r:focus-within .act",
  ],
};

/**
 * The three the same merge took with it, each still drawn by a live screen and
 * none of them findable by a search for top-level selector names: `.prow.tight`
 * is a compound on a class that survived, and the other two are descendants.
 */
const ALSO = [
  { file: "./StartComposer.tsx", token: "prow tight", rules: [".prow.tight", ".prow.tight .plg", ".prow.tight .plg img"] },
  { file: "./StartComposer.tsx", token: "need", rules: [".chip .need", ".chip .need::before"] },
  { file: "./config/AgentTeams.tsx", token: "box stack", rules: [".fld .box.stack", ".fld .box.stack > input", ".fld .box.stack .rows"] },
];

const SCREENS = [DISCOVER, TAKE, ...ALSO];

describe("the rules the plugin screens are drawn with", () => {
  it.each(SCREENS.flatMap((s) => s.rules.map((r) => [r] as const)))("defines %s", (rule) => {
    expect(defined).toContain(rule);
  });

  /**
   * The list only means something while the components still want these. A
   * screen that stops using one should shrink this file in the same commit,
   * rather than leaving a name here that nothing would miss.
   */
  it.each(SCREENS.map((s) => [s.file, s.token] as const))("%s still asks for .%s", (file, token) => {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    expect(src).toContain(token);
  });

  /** The one media variant in the restored set; a row of cards at 900px wide. */
  it("keeps the single-column fallback for the Discover grid", () => {
    expect(bare).toMatch(/@media \(max-width: 900px\) \{\s*\.offers \{ grid-template-columns: 1fr; \}/);
  });
});

/**
 * The declarations that carry the reported symptoms. A selector that exists
 * with the wrong body is the same bug reported a second time.
 */
describe("what those rules actually have to say", () => {
  it("keeps the Connect button on one line", () => {
    const act = declarations(".act");
    expect(act).toContain("white-space: nowrap");
    expect(act).toContain("flex: none");
  });

  it("draws Discover as two columns of rows rather than a stack", () => {
    expect(declarations(".offers")).toContain("grid-template-columns: 1fr 1fr");
    expect(declarations(".offers")).toContain("display: grid");
  });

  /** Why the descriptions had a line through them when the rules were gone. */
  it("strips the browser's decoration off the row's two sub-lines", () => {
    expect(declarations(".offer .tx s")).toContain("text-decoration: none");
  });

  /** Opacity rather than display, so a row does not reflow under the pointer. */
  it("hides the row's action without taking its space", () => {
    expect(declarations(".offer .act")).toContain("opacity: 0");
    expect(declarations(".offer:hover .act")).toContain("opacity: 1");
  });
});

/**
 * The structural guards. Neither of these is about any one rule — they are the
 * two ways this file has broken while every other check stayed green.
 */
describe("the shape of the sheet", () => {
  /**
   * A previous break here left a rule unclosed. `tsc` does not read this file,
   * the unit suite does not read it, and `check-style` did not notice.
   */
  it("balances its braces", () => {
    expect(unbalanced).toBe(false);
  });

  /**
   * **`@layer components` nested inside `@layer components` is the trap.** It
   * parses, it builds, and every rule inside it quietly loses to anything of
   * equal specificity below. So each one has to open at depth zero.
   */
  it("opens every layer at the top level", () => {
    expect(nestedLayers).toEqual([]);
  });

  /**
   * And the restored rules sit inside that layer rather than beside it. A
   * declaration outside every layer beats a layered one — which is right for
   * the three native ones at the head of this file, and wrong for a component:
   * it would put these above the utilities that are meant to override them.
   */
  it("keeps the restored rules inside a layer", () => {
    const wanted = new Set(SCREENS.flatMap((s) => s.rules));
    const outside = rules
      .filter((r) => !r.layered && r.selectors.some((s) => wanted.has(s)))
      .map((r) => r.selectors.join(", "));
    expect(outside).toEqual([]);
  });
});
