/**
 * The rules the Organisation panes take, tested where they are decided.
 *
 * **The trap these are written against:** there are two ways to list people and
 * they are not interchangeable. The colleague list is any signed-in user's and
 * carries a name and an id; the organisation's user list is administrators-only
 * and a member gets a 403. Building People on the second and hiding the buttons
 * for everybody else turns ⌘8 into a forbidden destination for most of the
 * organisation — and the specification is explicit that an empty or forbidden
 * destination *"is a defect, not an access rule"*.
 *
 * `git-hosts.test.tsx` met the same class of defect once already, on a field
 * drawn for everybody that the server would only take from an administrator,
 * and these are the same assertions one level up: which request is made, and
 * which controls are drawn, for each role — as a rule rather than as markup, so
 * they survive the row being rearranged.
 */
import { describe, expect, it } from "vitest";
import {
  actionsFor,
  administrators,
  changeFor,
  grantsHeldBy,
  howMany,
  locksTheRoom,
  mayAdminister,
  mayInvite,
  offboardingFor,
  readsFor,
  saidRole,
  tagsFor,
  teamActionsFor,
  type Account,
} from "./organisation";

const admin = { id: "u_kevin", role: "admin" } as const;
const member = { id: "u_tom", role: "member" } as const;

/** Everybody, as the administrators-only list answers. */
const org = (over: Partial<Account>[] = []): Account[] => [
  { id: "u_kevin", role: "admin" },
  { id: "u_ana", role: "admin" },
  { id: "u_tom", role: "member" },
  ...(over as Account[]),
];

/**
 * Which read applies, which is the whole of the permissions decision.
 *
 * The flags go straight into the two query hooks' `enabled`, deliberately,
 * because a word the caller then translates is where the mistake would go.
 */
describe("which list a role reads", () => {
  it("gives an administrator the organisation's user list and not the colleague list", () => {
    expect(readsFor(admin)).toEqual({ users: true, colleagues: false });
  });

  /**
   * **The acceptance criterion, as a rule.** A member's pane reads the list a
   * member may read, so it is populated rather than forbidden — and it never
   * issues the administrators-only one, so nothing in the session 403s.
   */
  it("gives a member the colleague list and never the administrators-only one", () => {
    expect(readsFor(member)).toEqual({ users: false, colleagues: true });
  });

  /**
   * **Neither, until the server has said who you are.** `me` is a request too,
   * and a pane that reads a role out of one still in flight defaults to an
   * answer that is wrong half the time — a member firing the
   * administrators-only list and taking a 403 on the way past is exactly the
   * thing the criterion forbids.
   */
  it("asks for nothing at all while the role is still in flight", () => {
    expect(readsFor(undefined)).toEqual({ users: false, colleagues: false });
    expect(readsFor(null)).toEqual({ users: false, colleagues: false });
    expect(readsFor({ id: "u_x", role: "" })).toEqual({ users: false, colleagues: false });
  });

  /** Anything the server starts calling a role is not an administrator here. */
  it("treats an unrecognised role as a member rather than as an administrator", () => {
    expect(readsFor({ id: "u_x", role: "auditor" })).toEqual({ users: false, colleagues: true });
    expect(mayAdminister({ id: "u_x", role: "auditor" })).toBe(false);
  });
});

describe("which controls a role may see", () => {
  it("offers the way to add somebody only to an administrator", () => {
    expect(mayInvite(admin)).toBe(true);
    expect(mayInvite(member)).toBe(false);
    expect(mayInvite(undefined)).toBe(false);
  });

  /**
   * **Nothing is greyed, and nothing is hidden-but-there.** A member's row has
   * no menu and no role at all — not because controls were withheld, but
   * because the colleague list carries a name and an id and the role is a fact
   * the server never told them.
   */
  it("gives a member no row controls and no role", () => {
    const row = actionsFor({ me: member, person: { id: "u_ana", role: "admin" } });
    expect(row.role).toBeNull();
    expect(row.menu).toEqual([]);
  });

  it("gives an administrator the role as a control and the row's own menu", () => {
    const row = actionsFor({ me: admin, person: { id: "u_ana", role: "admin" } });
    expect(row.role).toBe("menu");
    expect(row.menu).toEqual(["reset", "switch-off", "remove"]);
  });

  /** Switched off, so the one on offer is switching them back on. */
  it("offers switching on rather than off for a switched-off account", () => {
    const row = actionsFor({ me: admin, person: { id: "u_dan", role: "member", disabled: true } });
    expect(row.menu).toContain("switch-on");
    expect(row.menu).not.toContain("switch-off");
  });

  /**
   * **Your own row carries the role and nothing else.**
   *
   * Switching yourself off, removing yourself and offboarding yourself are all
   * refused by the server unconditionally — *"you cannot switch yourself off"*
   * — so a control for any of them has no outcome but a refusal, which is the
   * broken button `filing.ts` opens by describing. Resetting your own password
   * is the one of the four the server does not refuse, and it is still not
   * offered: the account screen replaces a password properly.
   *
   * The role stays a menu, because demoting yourself is the handover gesture
   * and the server allows it whenever somebody else administers.
   */
  it("offers nothing on your own row but the role", () => {
    const row = actionsFor({ me: admin, person: { id: admin.id, role: "admin" } });
    expect(row.menu).toEqual([]);
    expect(row.role).toBe("menu");
  });
});

/**
 * The last-administrator rule.
 *
 * The server owns it — `set_role` and `set_disabled` both refuse with *"<name>
 * is the only administrator"*, inside a transaction with the row locked, which
 * is the only place the answer is right when two administrators are changing
 * things at once. This is the same question a round trip earlier, so the reason
 * lands on the row before the request rather than after it.
 */
describe("the last administrator", () => {
  it("counts an administrator who is switched off as no administrator at all", () => {
    expect(administrators(org()).map((u) => u.id)).toEqual(["u_kevin", "u_ana"]);
    const half = org().map((u) => (u.id === "u_ana" ? { ...u, disabled: true } : u));
    expect(administrators(half).map((u) => u.id)).toEqual(["u_kevin"]);
  });

  /** Two of them, so either may be demoted or switched off. */
  it("is nothing in the way while somebody else administers", () => {
    expect(locksTheRoom(org(), "u_kevin", { role: "member" })).toBeNull();
    expect(locksTheRoom(org(), "u_kevin", { disabled: true })).toBeNull();
  });

  const alone: Account[] = [
    { id: "u_kevin", role: "admin" },
    { id: "u_tom", role: "member" },
  ];

  /**
   * **The whole sentence, including the pronoun.**
   *
   * `/only administrator/` was what this matched, which left the pronoun
   * unpinned — and it was *"**They** are the only administrator"*, drawn on
   * the row that also says **you**. It can only ever be that row: this returns
   * non-null when the single active administrator is the person asked about,
   * and anybody offered these controls is an active administrator themselves,
   * so one active administrator who is somebody else cannot arise. Matching
   * the exact string is the point — a loose pattern is how the wrong person
   * got named in the first place.
   */
  it("refuses demoting the only one, in a sentence about you", () => {
    expect(locksTheRoom(alone, "u_kevin", { role: "member" })).toBe(
      "You are the only administrator, so there would be nobody left to add people or change a role.",
    );
  });

  it("refuses switching the only one off, in the same sentence", () => {
    expect(locksTheRoom(alone, "u_kevin", { disabled: true })).toBe(
      "You are the only administrator, so there would be nobody left to add people or change a role.",
    );
  });

  /* The third person is the server's, where it is right — it is answering
     *about* somebody rather than *to* them, and it says which one by name. */
  it("never says it in the third person", () => {
    expect(locksTheRoom(alone, "u_kevin", { role: "member" })).not.toMatch(/\bThey\b|\bthey\b/);
  });

  /* A switched-off administrator is not one, so the one who can still sign in
     is the last — which is the arithmetic the server does. */
  it("refuses it when the other administrator is switched off", () => {
    const one: Account[] = [
      { id: "u_kevin", role: "admin" },
      { id: "u_ana", role: "admin", disabled: true },
    ];
    expect(locksTheRoom(one, "u_kevin", { role: "member" })).toMatch(/^You are the only administrator/);
  });

  /** Nothing is in the way of adding one, or of putting one back. */
  it("is never in the way of a change that adds an administrator", () => {
    expect(locksTheRoom(alone, "u_tom", { role: "admin" })).toBeNull();
    expect(locksTheRoom(alone, "u_kevin", { disabled: false })).toBeNull();
  });

  /** A member going is nobody's last administrator. */
  it("says nothing about a member", () => {
    expect(locksTheRoom(alone, "u_tom", { role: "member" })).toBeNull();
    expect(locksTheRoom(alone, "u_tom", { disabled: true })).toBeNull();
  });

  /** And nothing about a change that is neither — an email being filled in. */
  it("says nothing about a change that touches neither role nor state", () => {
    expect(locksTheRoom(alone, "u_kevin", {})).toBeNull();
  });
});

/**
 * What each thing a row offers actually asks the server for.
 *
 * The specification's testing section asks for *each mutation calling what it
 * should with what it should*, and its own guidance is to prefer the highest
 * meaningful seam and not to assert on the shape of generated client calls. So
 * this pins the **decision** — the body the pane asks for — rather than the
 * wire: `changeFor` is the one place the intent becomes a request, and it is
 * also the value `locksTheRoom` is asked about, which is what makes "could this
 * be refused" and "what am I asking for" one thing.
 */
describe("what each change asks for", () => {
  it("switches an account off and back on, and touches nothing else", () => {
    expect(changeFor("switch-off")).toEqual({ disabled: true });
    expect(changeFor("switch-on")).toEqual({ disabled: false });
  });

  it("changes a role, and touches nothing else", () => {
    expect(changeFor("admin")).toEqual({ role: "admin" });
    expect(changeFor("member")).toEqual({ role: "member" });
  });

  /**
   * **The guard and the request are the same object.** The one way the pane
   * can ask the server to lock the room is demoting the only administrator, so
   * composing the two is the whole of how the reason reaches the row a round
   * trip before the server would have said it.
   */
  it("is the same object the last-administrator rule is asked about", () => {
    const alone: Account[] = [{ id: "u_kevin", role: "admin" }];
    expect(locksTheRoom(alone, "u_kevin", changeFor("member"))).toMatch(/^You are the only administrator/);
    expect(locksTheRoom(alone, "u_kevin", changeFor("admin"))).toBeNull();
    expect(locksTheRoom(alone, "u_kevin", changeFor("switch-off"))).toMatch(/^You are the only administrator/);
    expect(locksTheRoom(alone, "u_kevin", changeFor("switch-on"))).toBeNull();
  });
});

/**
 * What agreeing to somebody going amounts to.
 *
 * **Agreeing to a list has to mean agreeing to *that* list.** The server
 * compares what is sent against what is actually theirs and refuses when they
 * differ — somebody is still working right up until the moment they are
 * switched off — so what is read back off the screen is what is sent, and the
 * two are one value rather than two expressions of it.
 */
describe("what removing somebody agrees to", () => {
  const owns = [
    { kind: "workspace", id: "w_1", name: "ledger" },
    { kind: "machine", id: "m_2", name: "builder" },
  ];

  it("names exactly what was shown, by kind and id", () => {
    expect(offboardingFor(owns, {}).destroy).toEqual([
      { kind: "workspace", id: "w_1" },
      { kind: "machine", id: "m_2" },
    ]);
  });

  /** Removing, never switching off — that is the row's own menu entry, and
   *  offering the lighter one here would make it look like part of this. */
  it("asks for a removal rather than a switch-off", () => {
    expect(offboardingFor(owns, {}).then).toBe("remove");
  });

  it("agrees to nothing when nothing is theirs", () => {
    expect(offboardingFor([], {}).destroy).toEqual([]);
  });

  /** A directory nobody else administers, and who takes it on. A grant names
   *  a person or a team, so both have to survive the translation. */
  it("hands on each directory they were the last administrator of", () => {
    const chosen = offboardingFor(owns, {
      d_backend: { kind: "person", id: "u_ana" },
      d_shared: { kind: "team", id: "t_platform" },
    });
    expect(chosen.successors).toEqual([
      { directory: "d_backend", subjectKind: "person", subjectId: "u_ana" },
      { directory: "d_shared", subjectKind: "team", subjectId: "t_platform" },
    ]);
  });

  it("hands nothing on when nobody has been chosen", () => {
    expect(offboardingFor(owns, {}).successors).toEqual([]);
  });
});

/**
 * The tags, which are drawn **only when there is something to say**.
 *
 * The administration site drew all four states as a column, where three of the
 * four values meant "fine" — so the column read as a status column about
 * nothing. And its *no email* was an ember link: ember means one thing in this
 * client, something is waiting on you, and a missing address on an old account
 * is not that.
 */
describe("what a row says about itself", () => {
  it("says nothing at all about the ordinary case", () => {
    expect(tagsFor({ email: "ana@acme.com", mustChangePassword: false, disabled: false })).toEqual([]);
  });

  it("says an account predates addresses being asked for", () => {
    expect(tagsFor({ email: null, mustChangePassword: false })).toEqual(["No email yet"]);
    expect(tagsFor({ email: "", mustChangePassword: false })).toEqual(["No email yet"]);
  });

  it("says somebody has not got here yet, which clears when they do", () => {
    expect(tagsFor({ email: "a@b.com", mustChangePassword: true })).toEqual(["Has not signed in"]);
    expect(tagsFor({ email: "a@b.com", mustChangePassword: false })).toEqual([]);
  });

  it("says switched off, and says it last", () => {
    expect(tagsFor({ email: null, mustChangePassword: true, disabled: true })).toEqual([
      "No email yet",
      "Has not signed in",
      "Switched off",
    ]);
  });
});

describe("what a role is called", () => {
  it("is the word somebody reads, not the word on the wire", () => {
    expect(saidRole("admin")).toBe("Administrator");
    expect(saidRole("member")).toBe("Member");
  });

  /* A role from a newer server. Drawing the raw word would put an unexplained
     token on the row; the dash says "something, and not one of the two". */
  it("does not invent a label for a role it does not know", () => {
    expect(saidRole("auditor")).toBe("—");
    expect(saidRole(null)).toBe("—");
  });
});

/* ── Teams ─────────────────────────────────────────────────────────────── */

/**
 * **Simpler than People, and genuinely a different shape.**
 *
 * The team list and one team's membership are readable by anybody, so there is
 * no read to pick by role and no two-endpoint split: same data, same rows, for
 * everybody. Only the write controls gate, and they gate at the control.
 */
describe("what a team's row offers", () => {
  const team = { everyone: false };
  const everybody = { everyone: true };

  it("gives an administrator the menu and a membership that writes", () => {
    expect(teamActionsFor({ me: admin, team })).toEqual({
      members: "write",
      menu: ["rename", "delete"],
    });
  });

  /**
   * **Not a thinner version of the administrator's row — the same row.** A
   * member sees every team and everybody in each, because that is what the
   * server tells them; what they do not get is a control, and a control
   * somebody does not have is not drawn rather than greyed.
   */
  it("gives a member the same rows and no controls at all", () => {
    expect(teamActionsFor({ me: member, team })).toEqual({ members: "read", menu: [] });
  });

  it("offers nothing while the role is still in flight", () => {
    expect(teamActionsFor({ me: undefined, team })).toEqual({ members: "read", menu: [] });
  });

  /**
   * **The team that is everybody offers nothing, to anybody.** All three are
   * refused on the server by name — *"the team that is everybody cannot be
   * renamed"*, *"…cannot be removed"*, *"everybody is already in that team"* —
   * so they are facts about what the team is rather than a permission a reader
   * lacks, and nothing is drawn rather than drawn and refused.
   */
  it("offers nothing on the team that is everybody, even to an administrator", () => {
    expect(teamActionsFor({ me: admin, team: everybody })).toEqual({
      members: "read",
      menu: [],
    });
  });
});

/**
 * What deleting a team would withdraw.
 *
 * `delete_team` revokes every grant the team held, by cascade — the whole
 * reason a team is worth having, and the reason removing one is worth stating
 * first. There is no team-shaped read for it, so the caller brings the
 * directory list and the grants on each and this turns them into the answer.
 */
describe("whether removing a team would withdraw access", () => {
  const platform = { name: "Platform", slug: "platform" };
  const shared = { name: "Shared", slug: "shared" };
  const byTeam = (id: string) => ({ subjectKind: "team", subjectId: id });
  const byPerson = (id: string) => ({ subjectKind: "person", subjectId: id });

  it("is nothing when the team holds no grants", () => {
    expect(
      grantsHeldBy("t_1", [{ directory: platform, grants: [byPerson("u_1"), byTeam("t_2")] }]),
    ).toEqual([]);
  });

  it("is nothing when there are no directories at all", () => {
    expect(grantsHeldBy("t_1", [])).toEqual([]);
  });

  it("names every directory the team can reach", () => {
    expect(
      grantsHeldBy("t_1", [
        { directory: platform, grants: [byTeam("t_1")] },
        { directory: shared, grants: [byPerson("u_1"), byTeam("t_1")] },
      ]),
    ).toEqual([
      { name: "Platform", slug: "platform" },
      { name: "Shared", slug: "shared" },
    ]);
  });

  /**
   * **A person and a team can share an id space, so the kind is checked too.**
   * Matching on `subjectId` alone would name a directory because somebody
   * whose id happened to collide was granted on it — which would be a sentence
   * about the wrong thing, in the one dialog that exists to be believed.
   */
  it("does not mistake a person's grant for the team's", () => {
    expect(grantsHeldBy("t_1", [{ directory: platform, grants: [byPerson("t_1")] }])).toEqual([]);
  });

  /** One row per directory, however the grants are shaped. */
  it("names a directory once", () => {
    expect(
      grantsHeldBy("t_1", [{ directory: platform, grants: [byTeam("t_1"), byTeam("t_1")] }]),
    ).toEqual([{ name: "Platform", slug: "platform" }]);
  });
});

describe("saying how many people", () => {
  it("counts in the words somebody reads", () => {
    expect(howMany(0)).toBe("0 people");
    expect(howMany(1)).toBe("1 person");
    expect(howMany(4)).toBe("4 people");
  });
});
