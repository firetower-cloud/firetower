/**
 * The map's own class names are its own.
 *
 * **This caught a real one.** The chip inside a card was `.sk`, which is the
 * *Skills pane's* row — `display: flex`, `padding: 13px 14px`, and
 * `margin-inline: -14px`. The scoped rule under `.oc` overrode most of it and
 * not the negative margin, so every chip was pulled 28px left of where the
 * layout had measured it: two chips on one row overlapped and the first one
 * rendered as a word cut in half. Nothing failed. The card was the right
 * size, the test that measures the lane passed, and the only way to see it
 * was to look at the screen.
 *
 * So the rule is: a name the map writes inside one of its own containers is
 * never a name the sheet already defines on its own. Reusing a shared class
 * deliberately — `.btn`, `.find`, `.r` — is a different thing and is listed
 * below as exactly that.
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SHEET = readFileSync(
  fileURLToPath(new URL("../../styles.css", import.meta.url)),
  "utf8",
);

/**
 * Every class the sheet styles on its own, with no ancestor in front of it.
 *
 * Those are the ones that reach into anything wearing the name, which is what
 * makes a collision silent.
 */
function bare(css: string): Set<string> {
  const out = new Set<string>();
  for (const [, name] of css.matchAll(/(?:^|\n)\s*\.([a-zA-Z][\w-]*)\s*(?:,|\{)/g)) out.add(name);
  return out;
}

/** The names the map writes inside `.oc`, `.mapbar`, `.swrow` and the sheets. */
const OURS = [
  "seat",
  "brf",
  "pins",
  "pinrow",
  "pin",
  "plus",
  "bin",
  "auto",
  "cnt",
  "nm",
  "mm",
  "pend",
  "lane",
  "knob",
  "vr",
  "hr",
];

/**
 * What the map wears on purpose, because it is the app's and means what the
 * app means by it.
 */
const BORROWED = ["btn", "quiet", "primary", "find", "ttag", "note2", "r", "g", "said", "sub"];

describe("the map's class names", () => {
  const defined = bare(SHEET);

  test("nothing it writes inside a card is a name the sheet styles on its own", () => {
    expect(OURS.filter((n) => defined.has(n))).toEqual([]);
  });

  /* The other half: the ones it does share are shared knowingly, and each is
     really in the sheet. A borrowed name that stopped existing would be a
     control drawn with no shape at all. */
  test("what it borrows exists, and is listed as borrowed", () => {
    for (const name of BORROWED) expect(SHEET).toContain(`.${name}`);
    expect(OURS.filter((n) => BORROWED.includes(n))).toEqual([]);
  });

  /* And the containers themselves, which have to be in the sheet or the map
     is drawn as a stack of unpositioned spans. */
  test("the map's own containers are styled", () => {
    for (const name of ["oc", "mapbar", "mapsurface", "mapplane", "swrow", "picklist", "sheetcard"]) {
      expect(defined.has(name), `.${name} is missing from styles.css`).toBe(true);
    }
  });
});
