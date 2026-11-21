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
 * So it is checked as a shape rather than as a behaviour: a `label` in one of
 * these sheets may not contain a `button`. That holds for the fields somebody
 * adds next, which is the half a test of *Led by* alone would not have.
 */
import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NewProfileSheet, Field, Group } from "./TeamSheet";

const AGENT_TEAMS = readFileSync(
  fileURLToPath(new URL("./AgentTeams.tsx", import.meta.url)),
  "utf8",
);

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
});
