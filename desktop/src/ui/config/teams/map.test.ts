/**
 * The map's two pure halves: where the cards go, and what Save would write.
 *
 * Both are tested here rather than through the screen because both are
 * *numbers and a list*, and a layout that can only be checked by rendering it
 * cannot be checked at all. The geometry assertions are the prototype's own
 * measurements — if one of these moves, the drawing moved with it.
 */
import { describe, expect, it } from "vitest";
import type { AgentTeam, Position } from "~/api/generated/model";
import { CH, CW, IND, layout, leadOf, depthOf, subtreeOf, treeOf } from "./layout";
import { add, descendants, draftOf, markOf, pending, remove, reparent, tell, toWrite } from "./draft";

const at = (over: Partial<Position> & { id: string }): Position => ({
  parent: null,
  profile: "role_a",
  name: "Engineer",
  does: "writes it",
  agent: "ClaudeCode",
  redacted: false,
  extraInstructions: "",
  ordinal: 0,
  ...over,
});

/** The worked example from the specification's own file format. */
const product = (): AgentTeam => ({
  id: "team_1",
  path: "u/kevin",
  name: "Product",
  mayWrite: true,
  mayShare: true,
  schedules: 0,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  positions: [
    at({ id: "lead", parent: null, profile: "role_em", name: "Engineering Manager" }),
    at({ id: "designer", parent: "lead", profile: "role_d", name: "Designer", ordinal: 0 }),
    at({ id: "web", parent: "lead", name: "Engineer", ordinal: 1, extraInstructions: "Owns the web client.\nFollow the design system in docs/." }),
    at({ id: "qa", parent: "web", profile: "role_qa", name: "QA", ordinal: 0 }),
    at({ id: "api", parent: "lead", name: "Engineer", ordinal: 2, extraInstructions: "Owns the API and the migrations." }),
  ],
});

describe("the tree", () => {
  it("is built from the flat list in sibling order", () => {
    const root = treeOf(product().positions)!;
    expect(root.position.id).toBe("lead");
    expect(root.kids.map((k) => k.key)).toEqual(["designer", "web", "api"]);
    expect(root.kids[1]!.kids.map((k) => k.key)).toEqual(["qa"]);
  });

  it("knows what goes with a position", () => {
    const root = treeOf(product().positions)!;
    const web = root.kids[1]!;
    expect(subtreeOf(web).map((n) => n.key)).toEqual(["qa"]);
    // The lead's subtree is everybody else, which is why removing it would be
    // removing the team.
    expect(subtreeOf(root)).toHaveLength(4);
  });

  it("reads the lead and the depth off a team without opening it", () => {
    expect(leadOf(product())!.name).toBe("Engineering Manager");
    expect(depthOf(product())).toBe(3);
  });
});

describe("the layout", () => {
  it("spreads the lead's children and indents below that", () => {
    const laid = layout(treeOf(product().positions));
    const card = (k: string) => laid.cards.find((c) => c.key === k)!;
    // The lead's three children share one row.
    expect(card("designer").y).toBe(card("web").y);
    expect(card("api").y).toBe(card("web").y);
    // And QA, a level further down, indents under its own parent rather than
    // opening a fourth column.
    expect(card("qa").x).toBe(card("web").x + IND);
    expect(card("qa").y).toBeGreaterThan(card("web").y);
  });

  it("centres a parent over the block its children fill", () => {
    const laid = layout(treeOf(product().positions));
    const card = (k: string) => laid.cards.find((c) => c.key === k)!;
    const lead = card("lead");
    const first = card("designer");
    const last = card("api");
    const middle = (first.x + last.x + CW) / 2;
    expect(Math.round(lead.x + CW / 2)).toBe(Math.round(middle));
  });

  it("gives a card carrying extra instructions one more line, and no more width", () => {
    const laid = layout(treeOf(product().positions));
    const told = laid.cards.find((c) => c.key === "web")!;
    const alone = layout(treeOf([at({ id: "solo", parent: null, name: "Alone" })]));
    expect(alone.cards[0]!.h).toBe(CH);
    expect(told.h).toBeGreaterThan(CH);
    // **No card changes width.** Turning anything on grows a card downward.
    expect(laid.cards.every((c) => c.w === CW)).toBe(true);
  });

  it("levels a spread row, so four siblings sit on one baseline", () => {
    // Two of the lead's three children carry instructions and one does not.
    // Four cards on one level reading as different kinds of thing is the
    // opposite of what a level means.
    const laid = layout(treeOf(product().positions));
    const row = ["designer", "web", "api"].map((k) => laid.cards.find((c) => c.key === k)!);
    expect(new Set(row.map((c) => c.h)).size).toBe(1);
    expect(new Set(row.map((c) => c.y + c.h)).size).toBe(1);
    // And the levelling takes the tallest rather than the first.
    expect(row[0]!.h).toBe(CH + 16);
  });

  it("leaves an indented stack to its own heights", () => {
    // They are stacked, not ranked side by side, so levelling them would add
    // space to say nothing.
    const laid = layout(treeOf(product().positions));
    expect(laid.cards.find((c) => c.key === "qa")!.h).toBe(CH);
  });

  it("draws one connector per edge, and none to a card that is not there", () => {
    const laid = layout(treeOf(product().positions));
    expect(laid.links).toHaveLength(4);
    expect(laid.links.every((l) => laid.cards.includes(l.from) && laid.cards.includes(l.to))).toBe(true);
  });

  it("stays narrow — the whole reason the arrangement is hybrid", () => {
    // Measured, not guessed: a classic organigramme throughout is 4640px on
    // the prototype's hardest lane. Three children and a grandchild should be
    // nowhere near one screen's width.
    const laid = layout(treeOf(product().positions));
    expect(laid.w).toBeLessThan(900);
  });

  it("answers for a team with no positions at all rather than throwing", () => {
    expect(layout(null).cards).toEqual([]);
  });
});

describe("the draft", () => {
  it("writes nothing until Save, and says how many changes are waiting", () => {
    const team = product();
    let d = draftOf(team);
    expect(pending(team, d)).toHaveLength(0);

    d = add(d, "lead", "role_sec", "Security", "reads for risk", null);
    d = remove(d, "designer");
    expect(pending(team, d).map((c) => c.kind).sort()).toEqual(["added", "removed"]);
    // The stored team is untouched — the map holds a copy.
    expect(team.positions).toHaveLength(5);
  });

  it("takes a whole subtree out, and Discard brings all of it back", () => {
    const team = product();
    const after = remove(draftOf(team), "web");
    expect(after.positions.map((p) => p.id).sort()).toEqual(["api", "designer", "lead"]);
    // Discard is re-reading the stored team, which is why a removed subtree
    // comes back whole: the tree was never touched.
    expect(draftOf(team).positions).toHaveLength(5);
  });

  it("counts what a removal takes, for the control that has to say so first", () => {
    expect(descendants(product().positions, "web").map((p) => p.id)).toEqual(["qa"]);
    expect(descendants(product().positions, "designer")).toHaveLength(0);
  });

  it("refuses to put a position under something already beneath it", () => {
    const d = draftOf(product());
    // The one move that is not a tree. Nothing else can make a cycle.
    expect(reparent(d, "web", "qa")).toBe(d);
    expect(reparent(d, "web", "web")).toBe(d);
    // And an ordinary move is taken.
    const moved = reparent(d, "qa", "designer");
    expect(moved.positions.find((p) => p.id === "qa")!.parent).toBe("designer");
  });

  it("marks what is pending on the card it happened to", () => {
    const team = product();
    let d = add(draftOf(team), "lead", "role_sec", "Security", "reads for risk", null);
    const made = d.positions.at(-1)!;
    expect(markOf(team, d, made.id)).toBe("add");
    expect(markOf(team, d, "designer")).toBe(null);
    d = reparent(d, "qa", "designer");
    expect(markOf(team, d, "qa")).toBe("move");
  });

  it("sends the whole team, with a saved position keeping its own id", () => {
    const team = product();
    const d = add(draftOf(team), "lead", "role_sec", "Security", "reads for risk", null);
    const write = toWrite(d);
    expect(write.positions).toHaveLength(6);
    // A position the server knows keeps its key, which is how the row — and
    // the sessions standing on it — survive the save.
    expect(write.positions.find((p) => p.key === "web")!.parent).toBe("lead");
    // And a new one carries a key the server will mint a row for.
    expect(write.positions.some((p) => p.key.startsWith("draft:"))).toBe(true);
  });

  it("tells one position something without touching the others", () => {
    const team = product();
    const d = tell(draftOf(team), "designer", "Owns the design system.");
    expect(d.positions.find((p) => p.id === "designer")!.extraInstructions).toBe("Owns the design system.");
    expect(d.positions.find((p) => p.id === "web")!.extraInstructions).toBe(
      team.positions.find((p) => p.id === "web")!.extraInstructions,
    );
    expect(pending(team, d)).toEqual([{ kind: "told", name: "Designer" }]);
  });

  it("reads a different profile on the lead row as a change of lead", () => {
    const team = product();
    const d = draftOf(team);
    d.positions = d.positions.map((p) => (p.id === "lead" ? { ...p, profile: "role_other", name: "Head of Platform" } : p));
    expect(pending(team, d)).toEqual([{ kind: "lead", name: "Head of Platform" }]);
  });
});

/* The sheets are not rendered here. Drawing `AgentTeams` needs a query client,
   a router and a confirm provider — a harness several times the size of what
   it would assert — and what was wrong with those sheets was visual: a field
   inside a field, an aside that said nothing, a foot against the edge. That
   is `pnpm shoot`'s business and a person's eye, not an assertion about
   markup. What is testable about the map is up there: the numbers, and what
   Save would write. */
