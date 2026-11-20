/**
 * The map's arithmetic, pinned against the arrangement that was measured.
 *
 * The two lanes below are the prototype's own seeded teams, and the sizes
 * asserted are the ones `agent-studio` measured and published on its Notes
 * tab. They are here rather than in a comment because the whole argument for
 * Hybrid is a measurement — a full organigramme came out at 4640px on the
 * hardest lane and Hybrid at 504px — and a measurement nothing checks is a
 * number that drifts.
 */
import { describe, expect, test } from "vitest";
import type { Position } from "~/api/generated/model";
import {
  CARD_H,
  CARD_W,
  SKILL_CAP,
  addChild,
  changes,
  chipRows,
  countUnder,
  depthOf,
  find,
  flatten,
  fromPositions,
  layout,
  moveSeat,
  removeSeat,
  toNewPosition,
  type Seat,
} from "./team-map";

/* ── The two lanes, as the API would answer them ─────────────────────────── */

let next = 0;
/** One seat, with the server ids a fetched team carries. */
function seat(profile: string, children: Seat[] = [], instructions = ""): Seat {
  const id = `p_${++next}`;
  return { key: id, id, profile, instructions, children };
}

/** Release Captain over an Engineering Manager, QA and Docs. 7 seats, 4 deep. */
const platform = () =>
  seat("release", [
    seat("em", [seat("designer"), seat("engineer", [seat("qa")])]),
    seat("qa"),
    seat("docs"),
  ]);

/** Two Engineer seats under one lead, told apart by what each is told. */
const product = () =>
  seat("em", [
    seat("designer", [seat("docs")]),
    seat("engineer", [seat("qa")], "Owns the web client."),
    seat("engineer", [seat("qa")], "Owns the API and the migrations."),
    seat("sec"),
  ]);

/** The seeded library's pinned skills, which is what a chip strip draws. */
const SKILLS = new Map<string, string[]>([
  ["release", ["changelog", "release-checks"]],
  ["em", ["spec-first"]],
  [
    "engineer",
    [
      "acceptance-tests",
      "api-contracts",
      "house-style",
      "migrations",
      "perf-budget",
      "release-checks",
      "repo-conventions",
    ],
  ],
  ["designer", ["firetower-surfaces", "prototype"]],
  ["qa", ["acceptance-tests"]],
  ["docs", ["house-style"]],
  ["sec", []],
]);

describe("Hybrid, measured", () => {
  /* The headline: both lanes are complete and both are narrower than the pane
     a 1296px window gives them (1296 − 62 rail − 252 panel = 982). */
  test("the two lanes come out at the sizes the arrangement was chosen on", () => {
    const a = layout(platform());
    expect([a.width, a.height]).toEqual([648, 296]);
    expect(a.cards).toHaveLength(7);

    const b = layout(product());
    expect([b.width, b.height]).toEqual([862, 226]);
    expect(b.cards).toHaveLength(8);
  });

  test("neither lane is wider than the pane a 1296px window leaves", () => {
    for (const lane of [layout(platform()), layout(product())]) expect(lane.width).toBeLessThan(982);
  });

  /**
   * **The switch changes height and nothing else.**
   *
   * Measured at every cap rather than at the shipping one: a cap that moved
   * the width would make the switch a layout change rather than a reading,
   * and that is the thing being ruled out.
   */
  test("showing skills moves height only, at every cap", () => {
    const off = layout(product());
    for (const cap of [3, 5, 10]) {
      const on = layout(product(), capped(SKILLS, cap));
      expect(on.width).toBe(off.width);
      expect(on.height).toBeGreaterThan(off.height);
    }
    expect(layout(product(), SKILLS).height).toBe(324);
    expect(layout(platform(), SKILLS).height).toBe(436);
  });

  test("the lead and its children spread; everything below indents", () => {
    const laid = layout(platform());
    const by = (p: string) => laid.cards.filter((c) => c.seat.profile === p);
    /* One row: the lead's three children share a y. */
    const level1 = laid.cards.filter((c) => c.depth === 1);
    expect(new Set(level1.map((c) => c.y)).size).toBe(1);
    /* And the Engineering Manager's two do not — they are stacked and inset. */
    const em = by("em")[0];
    const under = laid.cards.filter((c) => c.parent === em);
    expect(new Set(under.map((c) => c.y)).size).toBe(2);
    for (const c of under) expect(c.x).toBe(em.x + 22);
  });

  test("every card is one width, whatever it carries", () => {
    for (const lane of [layout(platform()), layout(product(), SKILLS)]) {
      for (const c of lane.cards) expect(c.w).toBe(CARD_W);
    }
  });

  test("a seat carrying extra instructions is one line taller", () => {
    const laid = layout(product());
    const [plain] = laid.cards.filter((c) => c.seat.profile === "sec");
    const [told] = laid.cards.filter((c) => c.seat.instructions);
    expect(plain.h).toBe(CARD_H);
    expect(told.h).toBe(CARD_H + 16);
  });

  /* The trunk leaves the bottom centre, which is where the control that makes
     a child sits. Both have to be the same point or the control is not on it. */
  test("the spread connector leaves a card at its bottom centre", () => {
    const laid = layout(product());
    const lead = laid.cards[0];
    const stem = laid.rules.find((r) => r.w === 1 && r.y === lead.y + lead.h);
    expect(stem?.x).toBe(lead.x + CARD_W / 2);
  });

  test("an empty team draws nothing rather than throwing", () => {
    expect(layout(null)).toEqual({ cards: [], rules: [], width: 0, height: 0, repeats: 0 });
  });

  test("a profile in two seats is counted once, and said so", () => {
    expect(layout(product()).repeats).toBe(2);
    expect(layout(platform()).repeats).toBe(1);
  });
});

/** A lane as a drawing: what is on it and where, without the minted ids. */
const shape = (laid: ReturnType<typeof layout>) => ({
  width: laid.width,
  height: laid.height,
  rules: laid.rules,
  cards: laid.cards.map((c) => [c.seat.profile, c.depth, c.x, c.y, c.w, c.h]),
});

/** The same skills, at a cap other than the shipping one. */
function capped(skills: Map<string, string[]>, cap: number): Map<string, string[]> {
  if (cap >= SKILL_CAP) return skills;
  return new Map([...skills].map(([k, v]) => [k, v.slice(0, cap)]));
}

describe("the chip strip", () => {
  test("whole names only, in order, filling a row before opening the next", () => {
    const rows = chipRows(SKILLS.get("engineer") ?? []);
    expect(rows).toEqual([
      ["acceptance-tests"],
      ["api-contracts", "house-style"],
      ["migrations", "perf-budget"],
      ["release-checks"],
      ["repo-conventions"],
    ]);
    /* Nothing is clipped: every chip is a name somebody could search for. */
    for (const name of rows.flat()) expect(SKILLS.get("engineer")).toContain(name);
  });

  test("past the cap it stops and counts the rest", () => {
    const many = Array.from({ length: 14 }, (_, i) => `skill-${i}`);
    const rows = chipRows(many, 10);
    expect(rows.flat().filter((c) => !c.startsWith("+"))).toHaveLength(10);
    expect(rows.flat()).toContain("+4");
  });

  test("nothing pinned draws no strip at all", () => {
    expect(chipRows([])).toEqual([]);
  });
});

/* ── The draft ───────────────────────────────────────────────────────────── */

describe("reading a team off the API", () => {
  const POSITIONS: Position[] = [
    { id: "p_a", profile: "r_lead", instructions: "", order: 0 },
    { id: "p_b", profile: "r_one", instructions: "Owns the web client.", order: 0, parent: "p_a" },
    { id: "p_c", profile: "r_two", instructions: "", order: 1, parent: "p_a" },
    { id: "p_d", profile: "r_three", instructions: "", order: 0, parent: "p_b" },
  ];

  test("the flat list rebuilds as the tree it was written as", () => {
    const root = fromPositions(POSITIONS);
    expect(root?.profile).toBe("r_lead");
    expect(root?.children.map((c) => c.profile)).toEqual(["r_one", "r_two"]);
    expect(root?.children[0].children.map((c) => c.profile)).toEqual(["r_three"]);
    expect(depthOf(root)).toBe(3);
  });

  test("a team whose lead profile was deleted is empty, not broken", () => {
    expect(fromPositions([])).toBeNull();
    expect(flatten(null)).toEqual([]);
    expect(depthOf(null)).toBe(0);
  });

  /* The id travels back, which is what keeps a session standing in its seat
     when somebody saves a team an agent is running in. */
  test("what a save sends carries each kept seat's own id", () => {
    const body = toNewPosition(fromPositions(POSITIONS) as Seat);
    expect(body).toEqual({
      id: "p_a",
      profile: "r_lead",
      children: [
        {
          id: "p_b",
          profile: "r_one",
          instructions: "Owns the web client.",
          children: [{ id: "p_d", profile: "r_three" }],
        },
        { id: "p_c", profile: "r_two" },
      ],
    });
  });

  test("a seat the map has just made carries no id", () => {
    const root = fromPositions(POSITIONS) as Seat;
    const drawn = addChild(root, "p_c", "r_four");
    const added = find(drawn, "p_c")?.children[0] as Seat;
    expect(added.id).toBeNull();
    expect(toNewPosition(drawn).children?.[1].children?.[0]).toEqual({ profile: "r_four" });
  });
});

describe("what is pending, and what Discard puts back", () => {
  test("nothing drawn is nothing pending", () => {
    const before = product();
    expect(changes(before, before)).toEqual([]);
  });

  test("each profile put under a card is one change", () => {
    const before = product();
    const lead = before.key;
    const after = addChild(addChild(before, lead, "r_new"), lead, "r_other");
    expect(changes(before, after)).toHaveLength(2);
    expect(changes(before, after).every((c) => c.kind === "add")).toBe(true);
    /* And the original is untouched, which is the whole of Discard. */
    expect(before.children).toHaveLength(4);
  });

  /**
   * **One gesture, one entry.** Taking out a seat with three under it is one
   * change and not four: the three went because the one did, and a count of
   * four would say somebody pressed four things.
   */
  test("taking out a subtree is one change that names the count", () => {
    const before = product();
    const em = before.children[1];
    const after = removeSeat(before, em.key);
    const diff = changes(before, after);
    expect(diff).toHaveLength(1);
    expect(diff[0]).toMatchObject({ kind: "remove", id: em.id, under: 1 });
    expect(countUnder(em)).toBe(1);
    expect(flatten(after)).toHaveLength(6);
  });

  test("Discard restores the whole removed subtree, because nothing was touched", () => {
    const before = product();
    const after = removeSeat(before, before.children[0].key);
    expect(flatten(after)).toHaveLength(6);
    /* Discard is this assignment, and what it restores is what it began as —
       every seat, in its place, at the geometry it was drawn at. */
    expect(flatten(before)).toHaveLength(8);
    expect(changes(before, before)).toEqual([]);
    expect(shape(layout(before))).toEqual(shape(layout(product())));
  });

  test("adding a seat and taking it back out leaves nothing pending", () => {
    const before = product();
    const added = addChild(before, before.key, "r_new");
    const key = added.children[4].key;
    expect(changes(before, added)).toHaveLength(1);
    expect(changes(before, removeSeat(added, key))).toEqual([]);
  });

  test("the lead has nothing to remove it with, and asking does nothing", () => {
    const before = product();
    expect(removeSeat(before, before.key)).toBe(before);
    expect(changes(before, removeSeat(before, before.key))).toEqual([]);
  });

  /* Nothing on the map calls this yet — it is the seam #494's drawer edits
     through — but what it does has to show in the diff like everything else. */
  test("re-parenting a seat is one change, and takes its subtree with it", () => {
    const before = product();
    const engineer = before.children[1];
    const after = moveSeat(before, engineer.key, before.children[0].key);
    expect(changes(before, after)).toEqual([
      { kind: "move", id: engineer.id, profile: "engineer" },
    ]);
    expect(flatten(after)).toHaveLength(8);
    expect(find(after, before.children[0].key)?.children.map((c) => c.profile)).toEqual([
      "docs",
      "engineer",
    ]);
  });

  test("a seat cannot be moved into its own subtree", () => {
    const before = product();
    const engineer = before.children[1];
    expect(moveSeat(before, engineer.key, engineer.children[0].key)).toBe(before);
  });
});
