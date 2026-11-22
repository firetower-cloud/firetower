/**
 * What can be started, and what picking it will do.
 *
 * **One control, two places.** `ProfileMenu` is what the composer drops from
 * its profile chip on the home page and the Dashboard, and what the schedules
 * sheet drops too — so this copy is everywhere somebody chooses what to run.
 *
 * It now holds two groups. A profile is one agent; a team is a lead with
 * others under it, and picking the team starts that lead with the team behind
 * it. **You never talk to a team**, so every team row names its lead and says
 * how many agents the pick can run — picking something that quietly starts
 * eight is the misleading case this list is shaped around.
 *
 * The footer changed with it. It used to say what profiles are *for*, on the
 * argument that somebody meeting an empty list needs the route rather than a
 * definition — which is still true, and is still what an empty list says. With
 * something picked it says the consequence instead, because one agent or eight
 * is not visible anywhere else: the chip shows a name, and a name says nothing
 * about how many agents a send will start.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProfileMenu, consequence } from "~/ui/StartComposer";
import type { AgentTeam, Position, Role } from "~/api/generated/model";

const role = (id: string, name: string) =>
  ({ id, name, does: "Reads the dependency diff", canDelegate: false, placement: "new" }) as unknown as Role;

const at = (over: Partial<Position> & { id: string }): Position => ({
  parent: null,
  profile: "p_01",
  name: "Ada, the lead",
  does: "leads",
  agent: null,
  redacted: false,
  extraInstructions: "",
  ordinal: 0,
  ...over,
});

const team = (over: Partial<AgentTeam> & { id: string; name: string }): AgentTeam => ({
  path: "u/kevin",
  mayWrite: true,
  mayShare: true,
  schedules: 0,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  positions: [at({ id: "pos_1" })],
  ...over,
});

const draw = (profiles: Role[], teams: AgentTeam[] = []) =>
  renderToStaticMarkup(
    <ProfileMenu profiles={profiles} teams={teams} profileId={null} teamId={null} onPick={() => {}} />,
  );

describe("the picker's two groups", () => {
  it("puts teams above profiles, under their own labels", () => {
    const html = draw([role("p_01", "Ada, the lead")], [team({ id: "t_1", name: "Product" })]);
    expect(html.indexOf("Teams")).toBeGreaterThan(-1);
    expect(html.indexOf("Teams")).toBeLessThan(html.indexOf("Profiles"));
  });

  it("names a team’s lead on the row — the entry that does not is the defect", () => {
    const html = draw([], [team({ id: "t_1", name: "Product" })]);
    expect(html).toContain("Product");
    expect(html).toContain("Led by Ada, the lead");
  });

  it("states how many agents the pick can run", () => {
    const eight = team({
      id: "t_1",
      name: "Product",
      positions: [at({ id: "pos_1" }), ...Array.from({ length: 7 }, (_, i) => at({ id: `pos_${i + 2}`, parent: "pos_1", name: "Engineer" }))],
    });
    expect(draw([], [eight])).toContain("8 agents");
    expect(draw([role("p_01", "Ada, the lead")])).toContain("1 agent");
  });

  it("shows a profile that leads a team twice, once in each group", () => {
    // They start different things and the rows say which, so this is the
    // clearest statement available rather than a collision.
    const html = draw([role("p_01", "Ada, the lead")], [team({ id: "t_1", name: "Product" })]);
    expect(html.split("Ada, the lead").length - 1).toBeGreaterThanOrEqual(2);
  });

  it("never offers a position — one only means something inside its tree", () => {
    const deep = team({
      id: "t_1",
      name: "Product",
      positions: [at({ id: "pos_1" }), at({ id: "pos_2", parent: "pos_1", name: "Engineer" })],
    });
    expect(draw([], [deep])).not.toContain("Engineer");
  });

  it("keeps Just an agent first, with nothing typed", () => {
    const html = draw([role("p_01", "Ada, the lead")], [team({ id: "t_1", name: "Product" })]);
    expect(html.indexOf("Just an agent")).toBeLessThan(html.indexOf("Product"));
  });
});

describe("what the footer says will happen", () => {
  const ada = role("p_01", "Ada, the lead");
  const product = team({
    id: "t_1",
    name: "Product",
    positions: [at({ id: "pos_1" }), at({ id: "pos_2", parent: "pos_1", name: "Engineer" }), at({ id: "pos_3", parent: "pos_1", name: "QA" })],
  });

  it("counts the others a team can reach, not the team", () => {
    expect(consequence([ada], [product], null, "t_1")).toBe(
      "Starts Ada, the lead, Product's lead. It can hand work to 2 other agents in the team.",
    );
  });

  it("says a profile on its own hands work to nobody", () => {
    expect(consequence([ada], [product], "p_01", null)).toContain("on its own");
    expect(consequence([ada], [product], "p_01", null)).toContain("cannot hand work to anybody");
  });

  it("does not promise reach a team of one does not have", () => {
    const alone = team({ id: "t_2", name: "Docs" });
    expect(consequence([ada], [alone], null, "t_2")).toContain("cannot hand work to anybody");
  });

  it("tells somebody with nothing yet what these are for, and offers the way in", () => {
    expect(consequence([], [], null, null)).toContain("divide your work across teams of agents");
  });

  it("says nothing at all when there is a choice and none is made", () => {
    // The line is about a consequence. Before anything is picked there is
    // none, and explaining what a profile and a team *are* to somebody
    // looking at a list of their own is furniture.
    expect(consequence([ada], [product], null, null)).toBe("");
    expect(draw([])).toContain("Create a profile");
  });

  it("and does not offer it when the menu already has something to pick", () => {
    // A way out of an empty list, not a second route to a page that is one
    // click away in the rail.
    expect(draw([role("p_01", "Ada, the lead")])).not.toContain("Create a profile");
  });
});
