/**
 * What a card offers, and to whom.
 *
 * The two things worth a test here are the ones a screenshot cannot settle:
 * **what the destructive control says before it is pressed**, and whether a
 * keyboard can reach it at all. A control a mouse can reach and a keyboard
 * cannot is half of this screen being unusable, and it is invisible in any
 * still picture of it.
 */
import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Position, Role } from "~/api/generated/model";
import { MapCard, removal } from "./TeamMap";
import { layout, type Seat } from "./team-map";

let next = 0;
const seat = (profile: string, children: Seat[] = [], instructions = ""): Seat => {
  const id = `p_${++next}`;
  return { key: id, id, profile, instructions, children };
};

const ENGINEER: Role = {
  id: "r_eng",
  name: "Engineer",
  does: "Turns an approved specification into working code.",
  agent: "Codex",
  canDelegate: false,
  createdAt: "",
  updatedAt: "",
  delegateScope: [],
  includeAlwaysOn: true,
  includeRepoDefaults: true,
  instructions: "",
  isDefault: false,
  mayShare: true,
  mayWrite: true,
  path: "yours",
  placement: "new",
  skillScope: [],
  onChildLimit: "ask",
  onUsageLimit: "wait",
  settings: {},
};

/** A card, drawn where the layout puts it, as markup. */
function draw(
  root: Seat,
  pick: (cards: ReturnType<typeof layout>["cards"]) => number,
  over: Partial<Parameters<typeof MapCard>[0]> = {},
) {
  const laid = layout(root);
  const card = laid.cards[pick(laid.cards)];
  return renderToStaticMarkup(
    <MapCard
      card={card}
      seat={undefined}
      role={ENGINEER}
      name={ENGINEER.name}
      skills={[]}
      selected={false}
      mayWrite
      onOpen={() => {}}
      onAdd={() => {}}
      onRemove={() => {}}
      {...over}
    />,
  );
}

describe("what a card offers", () => {
  const tree = () => seat("r_lead", [seat("r_eng", [seat("r_qa")]), seat("r_sec")]);

  test("the card itself takes focus, and both controls are inside it", () => {
    const html = draw(tree(), (c) => c.findIndex((x) => x.depth === 1));
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('role="button"');
    expect(html).toContain('class="plus"');
    expect(html).toContain('class="bin"');
    /* Inside the card, so `:focus-within` reveals them. A control outside it
       would be revealed by hover and by nothing else. */
    expect(html.indexOf('class="plus"')).toBeGreaterThan(html.indexOf('class="oc"'));
  });

  /**
   * The count, before the press.
   *
   * A removal takes the whole subtree, and a collapsed branch is a count
   * nobody can see — so the control says it rather than a dialog saying it
   * afterwards. There is no dialog: a removal is a draft and commits on Save.
   */
  test("the destructive control states what goes with it", () => {
    expect(removal("Engineer", 0)).toBe("Take Engineer out of this team");
    expect(removal("Engineer", 1)).toBe("Take Engineer and the one under it out of this team");
    expect(removal("Engineer", 3)).toBe("Take Engineer and the 3 under it out of this team");

    const html = draw(tree(), (c) => c.findIndex((x) => x.depth === 1));
    expect(html).toContain("Take Engineer and the one under it out of this team");
  });

  /* Removing it would remove the team, which is done from the list. */
  test("the lead has no destructive control, and still has a +", () => {
    const html = draw(tree(), () => 0);
    expect(html).not.toContain('class="bin"');
    expect(html).toContain('class="plus"');
    expect(html).toContain('data-lead="true"');
  });

  test("a reader who may not write this team gets neither control", () => {
    const html = draw(tree(), (c) => c.findIndex((x) => x.depth === 1), { mayWrite: false });
    expect(html).not.toContain('class="bin"');
    expect(html).not.toContain('class="plus"');
    /* The card still opens, because reading a position is not writing it. */
    expect(html).toContain('tabindex="0"');
  });

  test("a seat the map has drawn and not saved says so", () => {
    const root = seat("r_lead", []);
    root.children.push({ key: "new-1", id: null, profile: "r_eng", instructions: "", children: [] });
    const html = draw(root, (c) => c.findIndex((x) => x.depth === 1));
    expect(html).toContain('data-pending="true"');
  });
});

describe("a card whose profile the reader cannot see", () => {
  const tree = () => seat("r_lead", [seat("r_hidden")]);

  /**
   * Drawn, and unreadable.
   *
   * The shape of the tree belongs to the team, which they may see; the name
   * belongs to the profile, which they may not. A gap would misrepresent the
   * team, so the seat is there, marked, with the profile's id where its name
   * would be — a thing that is present rather than an error.
   */
  test("the seat is drawn, with its id and not its name", () => {
    const html = draw(tree(), (c) => c.findIndex((x) => x.depth === 1), {
      role: undefined,
      name: null,
    });
    expect(html).toContain('data-withheld="true"');
    expect(html).toContain("r_hidden");
    expect(html).toContain("You cannot see this profile");
  });

  test("and it is not drawn as a failure", () => {
    const html = draw(tree(), (c) => c.findIndex((x) => x.depth === 1), {
      role: undefined,
      name: null,
    });
    expect(html).not.toContain("brick");
    /* It still opens and it can still be taken out, because the seat is the
       team's even where the profile is not readable. */
    expect(html).toContain('class="bin"');
  });
});

describe("a seat nobody placed", () => {
  const auto = { autoAddedAt: "2026-11-02T09:00:00Z" } as unknown as Position;

  /* The whole mitigation for a team that can grow on its own is that the
     seats it grew are visible. If they looked like chosen ones there would be
     no mitigation. */
  test("reads differently from one somebody placed", () => {
    const tree = seat("r_lead", [seat("r_eng")]);
    const placed = draw(tree, (c) => c.findIndex((x) => x.depth === 1));
    const arrived = draw(tree, (c) => c.findIndex((x) => x.depth === 1), { seat: auto });
    expect(placed).toContain('data-auto="false"');
    expect(arrived).toContain('data-auto="true"');
    expect(arrived).toContain("Added automatically by a hand-off");
    expect(arrived).not.toEqual(placed);
  });
});

describe("skills on a card", () => {
  const tree = () => seat("r_lead", [seat("r_eng")]);
  const SKILLS = ["acceptance-tests", "api-contracts", "house-style"];

  /* A skill is a chip inside its card. Never a node, never connected by a
     line, and never counted among the positions. */
  test("are chips inside the card, and nothing else", () => {
    const html = draw(tree(), (c) => c.findIndex((x) => x.depth === 1), { skills: SKILLS });
    for (const name of SKILLS) expect(html).toContain(`<span class="pin">${name}</span>`);
    expect(html).toContain('class="pins"');
    /* The chip strip is inside the one card, so nothing can connect to it. */
    expect(html.match(/class="oc"/g)).toHaveLength(1);
  });

  test("whole names only — a clipped skill cannot be read or searched for", () => {
    const html = draw(tree(), (c) => c.findIndex((x) => x.depth === 1), {
      skills: ["a-very-long-skill-name-indeed"],
    });
    expect(html).toContain("a-very-long-skill-name-indeed");
  });
});
