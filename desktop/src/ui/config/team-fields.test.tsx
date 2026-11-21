/**
 * No field on these sheets is a `label` wrapped round a set of buttons.
 *
 * **This caught the one that stopped a team being created at all.** *Led by*
 * was a `Field`, which is a `label`. A `label` adopts the first labelable
 * thing inside it and forwards to that control every click that lands on the
 * label and misses one — its own words, the gap under them, the padding
 * around a row. Both halves of *Led by* are buttons, so:
 *
 *   * before a pick the adopted control was the first profile, and clicking
 *     the words *Led by* picked it;
 *   * after a pick the picker was gone and the adopted control was the chosen
 *     lead's **Change**, so the next click anywhere in the field cleared it.
 *
 * One click selected, the next unselected. From outside that is a row that
 * does nothing, and *Create team* that can never be satisfied. Every handler
 * was wired, every test passed and `tsc` was clean — the second click came
 * from the browser, not from the code.
 *
 * So it is checked as a shape rather than as a behaviour: a `Field` holds one
 * input, and a set of controls — or anything that draws one — belongs in a
 * `Group`. That holds for the fields somebody adds next, which is the half a
 * test of *Led by* alone would not have had, and it is what then found the
 * third instance: the drawer's *Who can use it*, which put the whole sharing
 * sheet inside a label whose adopted control was the chip that opened it.
 */
import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NewProfileSheet, Field, Group } from "./TeamSheet";

const src = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");
const AGENT_TEAMS = src("./AgentTeams.tsx");

/**
 * Every `<Field …>…</Field>` block in a source file, nesting respected.
 *
 * `Field` is a `label` in all three of these files, so this is "every label
 * the screens below write", read from the source because the screens that
 * hold them want a query client and a server to render.
 */
function fieldBlocks(code: string): string[] {
  const out: string[] = [];
  const open = /<Field(?=[\s>])/g;
  for (let m = open.exec(code); m; m = open.exec(code)) {
    const scan = /<(\/?)Field(?=[\s>/])|\/>/g;
    scan.lastIndex = m.index;
    let depth = 0;
    for (let t = scan.exec(code); t; t = scan.exec(code)) {
      if (t[0] === "/>") continue;
      depth += t[1] ? -1 : 1;
      if (depth === 0) {
        out.push(code.slice(m.index, scan.lastIndex));
        break;
      }
    }
  }
  return out;
}

/**
 * What may not appear inside one.
 *
 * **One labelable control in a `Field` is the point of a `Field`** — the
 * drawer's *Default* switch is exactly that, and clicking its words to flip it
 * is a label doing its job. What breaks is a label with *more than one*
 * control under it, or with something that draws one later: the label adopts
 * the first and forwards to it every click that lands on the label and misses.
 *
 * `ProfilePicker` is *Led by* and `pickrow` is *Where it lives*.
 * `WhoCanAccess` is the one that was missed longest: it is a button *and*,
 * while it is open, the whole sharing sheet — so a `Field` around it put a
 * modal inside a label whose adopted control was the chip that opened it, and
 * every click on the sheet's own chrome fired a second click on that chip.
 */
const NOT_IN_A_FIELD = ["WhoCanAccess", "ProfilePicker", "ShareMany", '"pickrow"'];

/** Every `<label>…</label>` in some markup, innermost first. */
function labels(html: string): string[] {
  const out: string[] = [];
  const open = /<label\b[^>]*>/g;
  for (let m = open.exec(html); m; m = open.exec(html)) {
    const from = m.index;
    let depth = 0;
    const scan = /<(\/?)label\b[^>]*>/g;
    scan.lastIndex = from;
    for (let t = scan.exec(html); t; t = scan.exec(html)) {
      depth += t[1] ? -1 : 1;
      if (depth === 0) {
        out.push(html.slice(from, scan.lastIndex));
        break;
      }
    }
  }
  return out;
}

const hasButton = (html: string) => /<button\b/.test(html);

describe("a field around a set of buttons", () => {
  /* The two shapes, side by side, so the difference is the thing under test
     rather than something to take on trust. */
  test("a Field is a label, and so may only ever hold one input", () => {
    const html = renderToStaticMarkup(
      <Field label="Name">
        <input />
      </Field>,
    );
    expect(html).toContain("<label");
    expect(hasButton(html)).toBe(false);
  });

  test("a Group is not a label, so each button inside it is its own control", () => {
    const html = renderToStaticMarkup(
      <Group label="Led by">
        <button type="button">Kevin</button>
        <button type="button">Someone else</button>
      </Group>,
    );
    expect(html).not.toContain("<label");
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Led by"');
  });

  /* And the sheet that has one. `filing` is what draws *Where it lives*, the
     other field on these sheets whose control is a row of buttons. */
  test("no label in the Create profile sheet holds a button", () => {
    const html = renderToStaticMarkup(
      <NewProfileSheet
        filing={[{ id: "d_1", name: "Design" }]}
        onClose={() => {}}
        onCreate={async () => {}}
      />,
    );
    expect(html).toContain("Where it lives");
    for (const l of labels(html)) expect(hasButton(l), `a label holds a button: ${l}`).toBe(false);
  });

  /**
   * And *Led by* itself, which is the field that was broken.
   *
   * Read from the source rather than rendered: the New team sheet is inside a
   * pane that wants a query client and a server behind it, and what is worth
   * pinning here is one line of markup. The two assertions below are the
   * regression — `Field` around that picker is the bug, by construction.
   */
  test("Led by is a Group, because both halves of it are buttons", () => {
    expect(AGENT_TEAMS).toContain('<Group label="Led by">');
    expect(AGENT_TEAMS).not.toContain('<Field label="Led by">');
  });

  /**
   * And the same rule over every screen this feature touches, rather than
   * over the two fields that were found by hand.
   *
   * Three instances of one mistake is a pattern: *Led by*, *Where it lives*,
   * and the drawer's *Who can use it*, which put the whole sharing sheet
   * inside a `label`. Each was wired correctly and each behaved oddly for a
   * reason that is in the HTML spec rather than in the code. So the shape is
   * checked for whatever gets added next: a `Field` holds one input, and
   * anything that is a control — or that draws one — belongs in a `Group`.
   */
  test.each([
    ["AgentTeams.tsx", "./AgentTeams.tsx"],
    ["TeamSheet.tsx", "./TeamSheet.tsx"],
    ["ProfileDrawer.tsx", "./ProfileDrawer.tsx"],
  ])("no Field in %s holds a control", (_name, file) => {
    for (const block of fieldBlocks(src(file))) {
      const label = block.slice(0, block.indexOf(">") + 1).replace(/\s+/g, " ");
      for (const bad of NOT_IN_A_FIELD)
        expect(block.includes(bad), `${bad} is inside ${label} — it wants a Group`).toBe(false);
      /* And the plain case: two controls under one label, where only the
         first of them can ever be the one a stray click reaches. */
      const buttons = block.match(/<button(?=[\s>])/g)?.length ?? 0;
      expect(buttons, `${label} holds ${buttons} buttons — it wants a Group`).toBeLessThan(2);
    }
  });
});
