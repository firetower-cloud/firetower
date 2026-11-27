/**
 * The Teams pane: what each role finds on it, and what the expander holds.
 *
 * **Different from People, and the difference is the point.** The team list and
 * one team's membership are readable by anybody — the server says so itself,
 * because granting to a team means choosing one from a list — so there is no
 * read to pick by role here and no forbidden request to avoid. Same data, same
 * rows, for everybody; **only the write controls gate**. These render the pane
 * twice from one seeded cache and assert that the rows are identical and the
 * controls are not.
 *
 * The membership is its own component because the row has to be pressed to
 * reach it and a static render cannot press anything — the same wall
 * `git-hosts.test.tsx` hit with its ⋯ menu. `Members` is exported and rendered
 * directly here, so the half of this pane that is *who is in each team* is
 * covered rather than assumed.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Members, Teams } from "./Teams";
import { getMeQueryKey } from "~/api/generated/auth/auth";
import {
  getListColleaguesQueryKey,
  getListTeamMembersQueryKey,
  getListTeamsQueryKey,
} from "~/api/generated/access/access";
import type { Colleague, Me, Team, User } from "~/api/generated/model";

const KEVIN: User = {
  id: "u_kevin",
  username: "kevin",
  slug: "kevin",
  email: "kevin@acme.co",
  role: "admin",
  orgId: "o_1",
  mustChangePassword: false,
  disabled: false,
};
const TOM: User = { ...KEVIN, id: "u_tom", username: "tom", slug: "tom", role: "member" };

const TEAMS: Team[] = [
  { id: "t_0", name: "Everyone", everyone: true, members: 6 },
  { id: "t_1", name: "Platform", everyone: false, members: 4 },
  { id: "t_2", name: "Design", everyone: false, members: 1 },
  /* A team somebody has made and not filled in yet, which is the state every
     new team passes through. */
  { id: "t_3", name: "Incident", everyone: false, members: 0 },
];

const PLATFORM: Colleague[] = [
  { id: "u_kevin", username: "kevin" },
  { id: "u_ana", username: "ana" },
];

const me = (user: User): Me => ({ user, organization: { id: "o_1", name: "Acme" } });

function cacheFor(signedIn: User) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false } },
  });
  cache.setQueryData(getMeQueryKey(), me(signedIn));
  cache.setQueryData(getListTeamsQueryKey(), TEAMS);
  cache.setQueryData(getListTeamMembersQueryKey("t_1"), PLATFORM);
  cache.setQueryData(getListTeamMembersQueryKey("t_3"), []);
  cache.setQueryData(getListColleaguesQueryKey(), [
    { id: "u_kevin", username: "kevin" },
    { id: "u_ana", username: "ana" },
    { id: "u_tom", username: "tom" },
  ]);
  return cache;
}

const draw = (signedIn: User) =>
  renderToStaticMarkup(
    <QueryClientProvider client={cacheFor(signedIn)}>
      <Teams />
    </QueryClientProvider>,
  );

const drawMembers = (signedIn: User, write: boolean, team = TEAMS[1]) =>
  renderToStaticMarkup(
    <QueryClientProvider client={cacheFor(signedIn)}>
      <Members team={team} teams={TEAMS} write={write} onChanged={() => {}} />
    </QueryClientProvider>,
  );

/**
 * The part that is the same for everybody, asserted against both so that a
 * change which quietly narrows the read for a member fails here.
 */
describe("the list, which is everybody's", () => {
  it.each([
    ["an administrator", KEVIN],
    ["a member", TOM],
  ])("names every team to %s", (_who, signedIn) => {
    const html = draw(signedIn);
    for (const t of TEAMS) expect(html).toContain(t.name);
  });

  it.each([
    ["an administrator", KEVIN],
    ["a member", TOM],
  ])("says how many people are in each, to %s", (_who, signedIn) => {
    const html = draw(signedIn);
    expect(html).toContain("4 people");
    expect(html).toContain("1 person");
    expect(html).toContain("0 people");
  });

  /**
   * **`Everyone` keeps its rule.** The membership that has to be true is
   * "however many people exist right now", so a team you could open and count
   * would imply somebody could be left out of it. Making the other rows
   * writable does not change that.
   */
  it.each([
    ["an administrator", KEVIN],
    ["a member", TOM],
  ])("gives the team that is everybody no expander, for %s", (_who, signedIn) => {
    const html = draw(signedIn);
    expect(html).toContain("everybody here, always");
    expect(html).toContain("Who is in Platform");
    expect(html).not.toContain("Who is in Everyone");
  });

  it.each([
    ["an administrator", KEVIN],
    ["a member", TOM],
  ])("does not send %s to the administration site", (_who, signedIn) => {
    const html = draw(signedIn);
    expect(html).not.toContain("Manage on the web");
    expect(html).not.toContain("administration site");
  });
});

describe("what an administrator may do", () => {
  it("is offered the way to make one", () => {
    expect(draw(KEVIN)).toContain("New team");
  });

  /** A static render cannot open the menu, so what is asserted is that the row
   *  has one, named for the team it is about. `teamActionsFor` is what is in
   *  it, tested in `organisation.test.ts`. */
  it("gets a menu on every team but the one that is everybody", () => {
    const html = draw(KEVIN);
    expect(html).toContain("What to do with Platform");
    expect(html).toContain("What to do with Incident");
    expect(html).not.toContain("What to do with Everyone");
  });

  it("can take somebody out of a team, and put somebody in", () => {
    const html = drawMembers(KEVIN, true);
    expect(html).toContain("Take ana out of Platform");
    expect(html).toContain("Add people");
  });
});

/**
 * **The whole of the permission difference, from the member's side.** Nothing
 * is greyed: the controls are simply not drawn, and the rows beside them are
 * the administrator's rows unchanged.
 */
describe("what a member may do", () => {
  it("is offered no way to make one", () => {
    expect(draw(TOM)).not.toContain("New team");
  });

  it("gets no menu on any row", () => {
    expect(draw(TOM)).not.toContain("What to do with");
  });

  it("sees who is in a team and no way to change it", () => {
    const html = drawMembers(TOM, false);
    expect(html).toContain("ana");
    expect(html).toContain("u/ana");
    expect(html).not.toContain("Take ana out of Platform");
    expect(html).not.toContain("Add people");
  });

  it("greys nothing, because it draws nothing it cannot use", () => {
    expect(draw(TOM)).not.toContain("disabled=");
    expect(drawMembers(TOM, false)).not.toContain("disabled=");
  });
});

describe("a team nobody is in yet", () => {
  /** Which every new team is, the moment after it is made — so it has to read
   *  as a start rather than as a list that failed to load. */
  it("says so, rather than drawing nothing", () => {
    expect(drawMembers(KEVIN, true, TEAMS[3])).toContain("Nobody is in it yet.");
  });

  it("still offers the way to put the first person in", () => {
    expect(drawMembers(KEVIN, true, TEAMS[3])).toContain("Add people");
  });
});
