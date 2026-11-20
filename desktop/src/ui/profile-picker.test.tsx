/**
 * The picker the composer drops from its profile chip: the empty state, and
 * the one-agent-or-eight distinction it exists to carry.
 *
 * **One control, three places.** `ProfileMenu` is what the composer drops on
 * the home page and the Dashboard, and what the schedules sheet drops too —
 * so this copy and this button are everywhere somebody meets an empty list,
 * which is the point of them.
 *
 * It used to define the word: *a profile is a saved way of working — what it
 * is for, what it may do, and who it may hand work to*. That is no use to
 * somebody who has never made one. What they need is what profiles are for
 * and a way to get one, and making one is two choices on the Profiles page —
 * describe it to an agent, or fill in the form — which is not a thing to
 * reproduce inside a menu.
 *
 * ## What the rows have to carry
 *
 * **You never talk to a team — you talk to its lead, with its team behind
 * it.** If the picker says *Growth* and the conversation opens with the
 * Orchestrator, the row misled somebody about the one thing it was for. So a
 * team names its lead and its size before it is picked, and the footer says
 * the consequence: a lead with N others reachable, against a profile that
 * cannot hand work to anybody.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  consequence,
  ProfileMenu,
  startableIn,
  startableMatches,
  startables,
  type StartAs,
} from "~/ui/StartComposer";
import type { AgentTeam, Role } from "~/api/generated/model";

const role = (id: string, name: string, canDelegate = false) =>
  ({ id, name, does: "Reads the dependency diff", canDelegate, placement: "new" }) as unknown as Role;

const team = (id: string, name: string, lead: Role | null, positions: number) =>
  ({
    id,
    name,
    lead: lead?.id,
    leadName: lead?.name,
    positions,
    path: `u/ada/${id}`,
    mayWrite: true,
    mayShare: true,
    schedules: 0,
    createdAt: "2026-11-01T09:00:00Z",
    updatedAt: "2026-11-01T09:00:00Z",
  }) as AgentTeam;

const draw = (profiles: Role[], teams: AgentTeam[] = [], startAs: StartAs = null) =>
  renderToStaticMarkup(
    <ProfileMenu profiles={profiles} teams={teams} startAs={startAs} onPick={() => {}} />,
  );

describe("the profile picker", () => {
  it("says what profiles are for rather than what the word means", () => {
    const html = draw([role("p_01", "Ada, the lead")]);
    expect(html).toContain("divide your work across teams of agents");
    expect(html).toContain("a designer, an engineer, a security advisor, a QA");
    expect(html).not.toContain("A profile is a saved way of working");
  });

  it("offers the Profiles page when there are none", () => {
    expect(draw([])).toContain("Create a profile");
  });

  it("and does not offer it when the menu already has something to pick", () => {
    // The button is a way out of an empty list, not a second route to a page
    // that is one click away in the rail.
    expect(draw([role("p_01", "Ada, the lead")])).not.toContain("Create a profile");
  });

  it("looks exactly as it did when there are no teams to tell apart", () => {
    // The group labels exist to disambiguate a team from a profile of the
    // same name. With no teams there is nothing to disambiguate, and a
    // heading over the only group is furniture pretending to be structure.
    const html = draw([role("p_01", "Ada, the lead")]);
    expect(html).not.toContain("Agent teams");
    expect(html).not.toContain(">Profiles<");
  });
});

describe("what the picker offers", () => {
  const ada = role("p_01", "Engineering Manager");
  const bo = role("p_02", "Designer");
  const product = team("t_01", "Product", ada, 8);

  it("groups teams above profiles", () => {
    const all = startables([product], [ada, bo]);
    expect(all.map((s) => `${s.kind}:${s.name}`)).toEqual([
      "team:Product",
      "profile:Designer",
      "profile:Engineering Manager",
    ]);
  });

  it("names a team's lead and its size before it is picked", () => {
    const html = draw([ada, bo], [product]);
    expect(html).toContain("Product");
    expect(html).toContain("Led by Engineering Manager");
    expect(html).toContain("8 agents");
  });

  it("shows a profile that leads a team twice, once bare and once as the team", () => {
    // Deliberate: the two start completely different things. One row standing
    // for both outcomes would leave nothing on screen saying which you were
    // about to get.
    const all = startables([product], [ada]);
    expect(all.filter((s) => s.lead === "Engineering Manager")).toHaveLength(2);
    expect(all.map((s) => s.kind)).toEqual(["team", "profile"]);
  });

  it("tells a team and a profile of the same name apart by the group labels", () => {
    // Common, because a team is often named after what its lead does. Neither
    // is renamed.
    const design = role("p_03", "Product");
    const html = draw([design], [product]);
    expect(html).toContain("Agent teams");
    expect(html).toContain("Profiles");
    expect(html.match(/>Product</g) ?? []).toHaveLength(2);
  });

  it("offers no position, ever", () => {
    // A position only means something inside its tree, and the only way to
    // reach one is through the team that holds it. This list is built from
    // the teams and the profiles and from nothing else.
    const all = startables([product], [ada, bo]);
    expect(all).toHaveLength(3);
    expect(all.every((s) => s.kind === "team" || s.kind === "profile")).toBe(true);
  });

  it("will not start a team whose lead profile is gone, and says why", () => {
    // A real state rather than an impossible one: deleting a profile cascades
    // onto its positions, and when the position was the root it takes the
    // whole tree. There is no lead's seat to stand in.
    const [leadless] = startables([team("t_02", "Growth", null, 0)], []);
    expect(leadless.blocked).toBe("It has no lead, so there is nobody to start");
    expect(draw([], [team("t_02", "Growth", null, 0)])).toContain("nobody to start");
  });

  it("will not start a team whose lead is a profile you cannot use", () => {
    const hidden = { ...team("t_03", "Platform", ada, 4), leadName: undefined };
    const [out] = startables([hidden], []);
    expect(out.blocked).toBe("Its lead isn't a profile you can use");
  });

  it("finds a team by its lead, which is what anybody remembers about one", () => {
    const [found] = startables([product], []);
    expect(startableMatches(found, "engineering")).toBe(true);
    expect(startableMatches(found, "prod")).toBe(true);
    expect(startableMatches(found, "designer")).toBe(false);
  });

  it("offers the box once there is more to scan than a handful, over both kinds", () => {
    // The desk's own threshold, now counting the teams: they are rows to read
    // past, and a box over four of anything is worth having.
    const few = draw([bo], [product]);
    expect(few).not.toContain("Search");
    const many = draw(
      [bo, ada, role("p_04", "QA"), role("p_05", "Security")],
      [product],
    );
    expect(many).toContain("Search teams and profiles");
  });
});

describe("the sentence under the box", () => {
  const ada = role("p_01", "Engineering Manager");
  const product = team("t_01", "Product", ada, 8);

  const say = (teams: AgentTeam[], profiles: Role[], start: StartAs) =>
    consequence(startableIn(startables(teams, profiles), start));

  it("states the consequence of a team: its lead, and what it can reach", () => {
    expect(say([product], [ada], { kind: "team", id: "t_01" })).toBe(
      "Starts Engineering Manager, Product's lead. It can hand work to 7 other agents in the team.",
    );
  });

  it("against a profile on its own, which cannot hand work to anybody", () => {
    expect(say([product], [ada], { kind: "profile", id: "p_01" })).toBe(
      "Starts Engineering Manager on its own. It cannot hand work to anybody.",
    );
  });

  it("counts one other as one agent, not one agents", () => {
    const pair = team("t_02", "Growth", ada, 2);
    expect(say([pair], [ada], { kind: "team", id: "t_02" })).toBe(
      "Starts Engineering Manager, Growth's lead. It can hand work to 1 other agent in the team.",
    );
  });

  it("says a team of one cannot hand work on either, rather than counting zero", () => {
    const alone = team("t_03", "Platform", ada, 1);
    expect(say([alone], [ada], { kind: "team", id: "t_03" })).toBe(
      "Starts Engineering Manager, Platform's lead. Nothing reports to it yet, so it cannot hand work to anybody.",
    );
  });

  it("does not claim a Manager profile cannot delegate while its old reach is live", () => {
    // True only of the new path during the compatibility window: a Manager
    // started bare does still hand work out through its own settings. Goes
    // with `roles.can_delegate` in #497.
    const manager = role("p_09", "Orchestrator", true);
    expect(say([], [manager], { kind: "profile", id: "p_09" })).toBe(
      "Starts Orchestrator on its own. Its own profile still lets it hand work out, which an agent team replaces.",
    );
  });

  it("says what is wrong with a row there is nothing to start", () => {
    // Reachable without picking one: a team's lead profile can be deleted
    // while a composer sits open holding that team. The sentence must not be
    // about a lead it does not have.
    const leadless = team("t_04", "Growth", null, 0);
    expect(say([leadless], [], { kind: "team", id: "t_04" })).toBe(
      "Growth can't be started. It has no lead, so there is nobody to start.",
    );
  });

  it("says nothing about a plain workspace, which the row already states", () => {
    expect(say([product], [ada], null)).toBeNull();
    // So the footer is free to say what profiles and teams are for.
    expect(draw([ada], [product])).toContain("its lead can hand work to the rest");
  });

  it("is on the footer the moment something is picked", () => {
    const html = draw([ada], [product], { kind: "team", id: "t_01" });
    expect(html).toContain("It can hand work to 7 other agents in the team.");
    expect(html).not.toContain("divide your work across teams of agents");
  });
});
