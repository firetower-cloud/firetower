/**
 * The drawer's own class names are its own.
 *
 * **This is `team-classes.test.ts`'s rule, applied to a screen that borrows
 * more.** #492 shipped a chip wearing `.sk` — the Skills pane's *row* —
 * carrying `margin-inline: -14px`; the scoped rule under `.oc` overrode most
 * of it and not the negative margin, so two chips on a row overlapped and the
 * first rendered as a word cut in half. Nothing failed: the card was the right
 * size, the test that measures the lane passed, `tsc` was clean, and the only
 * way to see it was to open the app and look at a 9px pill.
 *
 * The drawer reuses far more of the sheet than the map did — the form idioms,
 * the pill rows, the tab strip, the sheets — so the same mistake is easier to
 * make here, not harder. The rule is the same: **a name the drawer writes
 * inside one of its own containers is never a name the sheet already styles
 * on its own**, and what it borrows on purpose is listed below as borrowed.
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SHEET = readFileSync(
  fileURLToPath(new URL("../../styles.css", import.meta.url)),
  "utf8",
);

/**
 * Every class the sheet styles with no ancestor in front of it.
 *
 * Those are the ones that reach into anything wearing the name, which is what
 * makes a collision silent.
 */
function bare(css: string): Set<string> {
  const out = new Set<string>();
  for (const [, name] of css.matchAll(/(?:^|\n)\s*\.([a-zA-Z][\w-]*)\s*(?:,|\{)/g)) out.add(name);
  return out;
}

/** The names the drawer writes inside `.pdrawer`, `.place` and the sheets. */
const OURS = [
  "dnav",
  "dhead",
  "dchips",
  "dchip",
  "dbody",
  "dfoot",
  "dlede",
  "dread",
  "crumb",
  "addsk",
  "jh",
  "jsaid",
  "ptree",
  "pr",
  "ph",
];

/**
 * What it wears on purpose, because it is the app's and means what the app
 * means by it.
 *
 * `.itabs` and `.itab` are the right rail's own index — the same control, in
 * the same place, doing the same job; `.fld`, `.hint`, `.pickrow`, `.pk`,
 * `.pickrows`, `.pr2`, `.ladder` and `.inform` are the form's idioms, moved
 * here with the fields that use them; `.btn`, `.find`, `.msg`, `.r`,
 * `.sheetcard` and `.scroll-slim` are the app's.
 */
const BORROWED = [
  "itabs",
  "itab",
  "ul",
  "fld",
  "hint",
  "pickrow",
  "pickrows",
  "pk",
  "pr2",
  "ladder",
  "inform",
  "btn",
  "find",
  "msg",
  "sub",
  "ic",
  "tx",
  "g",
  "nm",
  "ds",
  "r",
  "sheetcard",
  "whereto",
];

describe("the drawer's class names", () => {
  const defined = bare(SHEET);

  test("nothing it writes inside its own containers is a name the sheet styles alone", () => {
    expect(OURS.filter((n) => defined.has(n))).toEqual([]);
  });

  /* The other half: the ones it does share are shared knowingly, and each is
     really in the sheet. A borrowed name that stopped existing would be a
     control drawn with no shape at all. */
  test("what it borrows exists, and is listed as borrowed", () => {
    for (const name of BORROWED) expect(SHEET).toContain(`.${name}`);
    expect(OURS.filter((n) => BORROWED.includes(n))).toEqual([]);
  });

  /* And the containers themselves, which have to be in the sheet or the
     drawer is a stack of unstyled divs over the page it docks beside. */
  test("the drawer's own containers are styled", () => {
    for (const name of [
      "pdock",
      "pdockmain",
      "pdockrail",
      "pdockover",
      "pdockgrip",
      "pdrawer",
      "dshared",
      "joinbox",
      "instrbox",
      "bigedit",
      "places",
      "place",
      "takes",
      "scopebox",
      "tick2",
    ]) {
      expect(defined.has(name), `.${name} is missing from styles.css`).toBe(true);
    }
  });

  /**
   * **The pane is the container the bands are measured on**, so it has to be
   * a container. Without `container-type` the `@container` rules below it are
   * inert and a docked drawer crushes the list's names to seven characters
   * while the path keeps its full width — which is what it did.
   */
  test("the pane is a query container, so a squeezed row can shed columns", () => {
    expect(SHEET).toMatch(/\.pdockmain\s*\{[^}]*container-type:\s*inline-size/);
    expect(SHEET).toMatch(/@container \(max-width: \d+px\)\s*\{\s*\.pdockmain \.r \.path/);
  });
});
