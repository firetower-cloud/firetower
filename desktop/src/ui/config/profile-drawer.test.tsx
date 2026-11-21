/**
 * What the drawer says, and what it must never say.
 *
 * Four things here are worth a test rather than a screenshot, because each is
 * a sentence somebody acts on or a rule a picture cannot settle:
 *
 * - **the blast radius before a delete** — deleting a profile cascades onto
 *   every position that references it, and the teams that lose them are not
 *   on screen;
 * - **how far a save reaches**, which is the band's fact at the moment of
 *   pressing;
 * - **a seat whose profile this reader cannot see**, which discloses an id on
 *   purpose and must disclose nothing else;
 * - **which fields differ**, because Save is the only commit and a count that
 *   drifted would offer one where there is nothing to write.
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProfilePosition, Role } from "~/api/generated/model";
import {
  Blast,
  withheldLine,
  InTeams,
  OldReach,
  PROFILE_TABS,
  ProfileDrawer,
  SEAT_TABS,
  SHARED,
  diffOf,
  notSaved,
  willSave,
  type SeatHandle,
} from "./ProfileDrawer";
import { ANY_ENGINE, toDraft } from "./profile-draft";

const REVIEWER: Role = {
  id: "r_rev",
  name: "Reviewer",
  does: "Reads a change and says what is wrong with it.",
  agent: "ClaudeCode",
  canDelegate: false,
  createdAt: "",
  updatedAt: "",
  delegateScope: [],
  includeAlwaysOn: true,
  includeRepoDefaults: true,
  instructions: "Read the diff.",
  isDefault: false,
  mayShare: true,
  mayWrite: true,
  path: "u/kevin",
  placement: "here",
  skillScope: [],
  onChildLimit: "ask",
  onUsageLimit: "wait",
  settings: {},
};

const sits = (over: Partial<ProfilePosition>): ProfilePosition => ({
  team: "at_1",
  teamName: "Product",
  position: "p_1",
  leads: false,
  under: [],
  instructions: "",
  takes: 1,
  mayWrite: true,
  ...over,
});

/* ── What a delete takes with it ───────────────────────────────────────── */

describe("the confirmation before a profile is deleted", () => {
  const says = (places: ProfilePosition[], withheld = 0) =>
    renderToStaticMarkup(<Blast name="Engineer" used={{ places, withheld }} />).replace(
      /<[^>]+>/g,
      " ",
    );

  test("a profile no team uses says that, rather than a count of nothing", () => {
    const said = says([]);
    expect(said).toContain("No team holds a position for it");
    expect(said).not.toContain("0 positions");
  });

  /**
   * **The one sentence that could not be made true.** Deleting a profile
   * cascades onto every team in the organisation, and the list this is built
   * from is filtered to what the person can see — so *no team holds a
   * position for it* was a claim about rows nobody read, and false in exactly
   * the ordinary case: a profile shared into a directory, and somebody else's
   * team built around it.
   */
  test("teams it cannot see are counted rather than denied", () => {
    const said = says([], 2);
    expect(said).not.toContain("No team holds a position for it");
    expect(said).toContain("This removes 2 positions in all");
    expect(said).toContain("They are in teams you cannot see");
    expect(said).toContain("Agents already running are untouched");
  });

  /** The singular, which is the half that is silently wrong. */
  test("one position in one invisible team reads as one", () => {
    const said = says([], 1);
    expect(said).toContain("This removes 1 position in all");
    expect(said).toContain("It is in a team you cannot see");
  });

  /** Named where they can be, counted where they cannot, in one dialog. */
  test("it says both when there is something of each", () => {
    const said = says([sits({ teamName: "Product", takes: 3 })], 2);
    expect(said).toContain("Product");
    expect(said).toContain("loses 3 positions");
    expect(said).toContain("2 of them are in teams you cannot see");
  });

  /**
   * **Every team, named.** The whole reason this dialog exists is that the
   * other teams are not on screen; a count without the names would be the
   * same gap it is here to close.
   */
  test("it names every team and what each one loses", () => {
    const said = says([
      sits({ team: "at_1", teamName: "Product", takes: 3 }),
      sits({ team: "at_2", teamName: "Platform", position: "p_2", takes: 1 }),
    ]);
    expect(said).toContain("Product");
    expect(said).toContain("Platform");
    expect(said).toContain("loses 3 positions");
    expect(said).toContain("loses 1 position");
    expect(said).toContain("This removes 4 positions in all");
  });

  /** Two seats in one team are one row, and the counts add up. */
  test("two seats in one team are counted together under that team's name", () => {
    const said = says([
      sits({ position: "p_1", takes: 2 }),
      sits({ position: "p_2", takes: 1 }),
    ]);
    expect(said).toContain("This removes 3 positions in all");
    expect(said).toContain("loses 3 positions");
  });

  /**
   * **The total is inclusive, and the sentence says so once.**
   *
   * `takes` is a seat and its subtree, and `withheld` is the same walk over
   * the teams that were filtered out — so *and everything under them* after
   * either number read as more to come, and a reader braced for more than
   * the number said. The subtree is named where the total is, and every row
   * beneath is a share of it.
   */
  test("the number already counts what is under those seats, and says so", () => {
    const said = says([sits({ teamName: "Product", takes: 3 })], 2);
    expect(said).toContain("This removes 5 positions in all");
    expect(said).toContain("everything reporting under them");
    expect(said).not.toMatch(/positions? from (one|\d+) teams?, and everything under them/);
    // The rows under it add up to the total rather than extending it.
    expect(said).toContain("loses 3 positions");
    expect(said).toContain("2 of them are in teams you cannot see");
  });

  test("the withheld line is a share when something was named and the whole when not", () => {
    expect(withheldLine(0, true)).toBeNull();
    expect(withheldLine(1, true)).toBe(
      "One of them is in a team you cannot see. There is nothing here that can name it.",
    );
    expect(withheldLine(2, true)).toBe(
      "2 of them are in teams you cannot see. There is nothing here that can name them.",
    );
    expect(withheldLine(1, false)).toBe(
      "It is in a team you cannot see. There is nothing here that can name it.",
    );
    expect(withheldLine(3, false)).toBe(
      "They are in teams you cannot see. There is nothing here that can name them.",
    );
  });

  /**
   * **A team it leads loses everything, not a branch.** Deleting the lead
   * takes the root, and the whole tree goes with it — which leaves the team
   * standing with no positions at all. That is a different sentence from
   * pruning and gets one.
   */
  test("a team this profile leads says so", () => {
    const said = says([sits({ leads: true, takes: 6 })]);
    expect(said).toContain("loses its lead and all 6 positions");
  });

  test("agents already running are said to be untouched", () => {
    expect(says([sits({})])).toContain("Agents already running are untouched");
    expect(says([])).toContain("Agents already running are untouched");
  });
});

/* ── How far a change reaches ──────────────────────────────────────────── */

describe("what the foot says before Save is pressed", () => {
  /* One team is not worth a clause: the drawer is the only thing on screen
     and there is nothing it is hiding. */
  test("one team spends no words on reach", () => {
    expect(willSave(1, 1)).toBe("1 change.");
    expect(willSave(2, 0)).toBe("2 changes.");
  });

  test("more than one is counted, because the others are not on screen", () => {
    expect(willSave(1, 2)).toBe("1 change, in both teams using this profile.");
    expect(willSave(3, 4)).toBe("3 changes, in all 4 teams using this profile.");
  });

  /** Leaving says the same fact in the voice the map's own question uses. */
  test("leaving says what has not been saved, in the same shape", () => {
    expect(notSaved(2, 3)).toBe(
      "Not saved yet: 2 changes to the profile, in all 3 teams that use it.",
    );
    expect(notSaved(0, 3)).toBe("Nothing is saved yet.");
  });
});

/* ── What differs ──────────────────────────────────────────────────────── */

describe("which fields a save would write", () => {
  test("a draft nobody touched writes nothing", () => {
    expect(diffOf(REVIEWER, toDraft(REVIEWER))).toEqual([]);
  });

  test("a changed field is named, and only that one", () => {
    expect(diffOf(REVIEWER, { ...toDraft(REVIEWER), does: "Something else" })).toEqual(["does"]);
  });

  /**
   * **Typing and untyping leaves nothing to save**, which a log of edits gets
   * wrong by default. The map derives its pending count the same way and for
   * the same reason.
   */
  test("a field put back as it was is not a change", () => {
    const draft = { ...toDraft(REVIEWER), name: "Rev" };
    expect(diffOf(REVIEWER, draft)).toEqual(["name"]);
    expect(diffOf(REVIEWER, { ...draft, name: REVIEWER.name })).toEqual([]);
  });

  /* A set, not a sequence: pinning two skills and pinning the same two in the
     other order is one answer, and offering a save for it would be noise. */
  test("a list is compared as a set", () => {
    const draft = { ...toDraft(REVIEWER), skillScope: ["sk_b", "sk_a"] };
    expect(diffOf({ ...REVIEWER, skillScope: ["sk_a", "sk_b"] }, draft)).toEqual([]);
    expect(diffOf(REVIEWER, draft)).toEqual(["skillScope"]);
  });
});

/* ── The band, and the foot it has to agree with ───────────────────────── */

/**
 * **The band is the one explanatory note this design keeps**, so it has to be
 * right.
 *
 * It was not. `SHARED` was written beside the tab list rather than derived
 * from it and left *In teams* out, so from a card that tab's band read *This
 * applies in Product only. It does not change the profile* while the foot of
 * the same pane read *Will save 1 change to the profile, in both teams that
 * use it*. A band that states the wrong scope is worse than no band: it
 * reassures somebody immediately before they change something everywhere.
 *
 * The two are generated separately, which is how they drifted, so what is
 * pinned here is the thing that makes drift impossible — one list — and the
 * fact behind it: every tab but *Custom* can change a profile field.
 */
describe("which tabs say they change the profile", () => {
  test("Custom is the only one that does not, and it is the first from a card", () => {
    expect(SEAT_TABS[0]![0]).toBe("custom");
    expect(SHARED.custom).toBeUndefined();
    expect(SEAT_TABS.filter(([id]) => !SHARED[id]).map(([id]) => id)).toEqual(["custom"]);
  });

  /* Derived rather than listed twice, which is the fix: a tab added to the
     list is shared by construction. */
  test("every tab a library row opens is shared", () => {
    expect(Object.keys(SHARED).sort()).toEqual(PROFILE_TABS.map(([id]) => id).sort());
  });

  /**
   * **Teams own delegation, so the drawer offers no control that says
   * otherwise.** The old per-profile reach is still live on the wire for the
   * compatibility window — #497 is what removes it — but a toggle reading
   * *Hands work off*, sitting beside the teams that actually decide it, is
   * read as the thing that decides it. The controls are gone; the fields they
   * wrote are not, and `the fields a profile carries survive a save` below is
   * the half that pins that.
   */
  test("In teams offers no per-profile delegation control", () => {
    const drawn = renderToStaticMarkup(
      <InTeams role={REVIEWER} places={[]} loading={false} here={null} />,
    );
    expect(SHARED.where).toBe(true);
    for (const gone of [
      "Before teams",
      "Does the work itself",
      "Hands work off",
      "On its own list",
      "When a child runs out",
    ])
      expect(drawn).not.toContain(gone);
  });

  /**
   * The other half, and the one that would be expensive to get wrong: taking
   * the controls out must not take the data with them. A profile that already
   * hands work off still says so after a save it made no change to.
   */
  test("the fields a profile carries survive a save", () => {
    const carrying: Role = {
      ...REVIEWER,
      canDelegate: true,
      delegateScope: ["r_other"],
      onChildLimit: "reroute",
    };
    const draft = toDraft(carrying);
    expect(draft.canDelegate).toBe(true);
    expect(draft.delegateScope).toEqual(["r_other"]);
    expect(draft.onChildLimit).toBe("reroute");
  });
});

/* ── In teams, where each row is a destination ─────────────────────────── */

/**
 * **A card that renders as pressable and does nothing is worse than a plain
 * one.**
 *
 * `onGoToSeat` was declared, threaded down to here and read — and neither
 * screen passed it, so every row rendered disabled from both entry points.
 * That is criterion B4 and the issue's own *each is a destination*. Two
 * halves are pinned: the row obeys the prop, and both callers hand one over.
 */
describe("the In teams rows", () => {
  const places = [sits({ teamName: "Product", takes: 2, under: ["Designer"] })];
  const draw = (onGoToSeat?: (team: string, position: string) => void) =>
    renderToStaticMarkup(
      <InTeams
        role={REVIEWER}
        places={places}
        loading={false}
        here={null}
        onGoToSeat={onGoToSeat}
      />,
    );

  test("a row is pressable when there is somewhere to go", () => {
    expect(draw(() => {})).not.toContain("disabled");
  });

  /* And honest when there is not, rather than drawn as a control that does
     nothing. Nothing reaches this state today; it is what the prop means. */
  test("and plainly not when there is not", () => {
    expect(draw(undefined)).toContain("disabled");
  });

  test("both screens that open the drawer hand it one", () => {
    const here = (name: string) =>
      readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
    // The library opens the map at that team, at that seat.
    expect(here("./Roles.tsx")).toMatch(/onGoToSeat=\{\(team, position\) =>/);
    expect(here("./Roles.tsx")).toContain("/configuration/agent-teams/${team}/${position}");
    // The map is already on screen, so a seat in this team is a selection.
    expect(here("./TeamMap.tsx")).toMatch(/onGoToSeat=\{\(team, position\) =>/);
  });
});

/* ── A seat whose profile the reader cannot see ────────────────────────── */

/**
 * **The id is disclosed on purpose; nothing else is.**
 *
 * #490 recorded the id as intended rather than as a leak — a gap would
 * misrepresent the team, and the map exists to convey the team's shape. #492
 * then fixed a real one, where the map recovered a withheld name from the
 * profile list. The drawer reads a profile *by id*, so it is the easiest
 * place for that leak to come back: it is told the name was withheld rather
 * than working it out, and it draws no profile at all.
 */
describe("a redacted seat, in the drawer", () => {
  const seat: SeatHandle = {
    team: "at_1",
    teamName: "Product",
    position: "p_9",
    key: "p_9",
    instructions: "Owns the web client.",
    leads: false,
    under: "p_1",
    underName: "Engineer",
    elsewhere: [],
    mayWrite: true,
    onInstructions: () => {},
    onReparent: () => {},
  };
  const drawn = renderToStaticMarkup(
    <ProfileDrawer profile="r_secret" seat={seat} withheld onClose={() => {}} />,
  );

  test("it shows the id, and the team it sits in", () => {
    expect(drawn).toContain("r_secret");
    expect(drawn).toContain("Product");
  });

  test("it shows the seat's own instructions, which the team answered with", () => {
    expect(drawn).toContain("Owns the web client.");
  });

  /** The whole point: no tabs, because four of the five are about a profile. */
  test("it offers no tabs and no Save", () => {
    expect(drawn).not.toContain('role="tab"');
    expect(drawn).not.toContain("Save changes");
  });

  test("it says why the name is missing, rather than drawing a gap", () => {
    expect(drawn).toContain("filed somewhere you cannot reach");
  });
});

/* ── Every field the form had ──────────────────────────────────────────── */

/**
 * **A field that silently disappears is the worst outcome of this change.**
 *
 * The drawer replaced a full-page form of nineteen fields, and nobody notices
 * a missing one until they need it — by which time it looks like data loss
 * rather than a design decision. `role-draft.test.ts` already guards the other
 * direction: a field on the wire that no draft carries. This guards this one:
 * a field a draft carries that no tab writes.
 *
 * Source text rather than a render, because several of these are drawn only
 * once an engine is pinned or a machine exists, and a test that had to reach
 * those states would be testing the fixtures.
 */
describe("every field a draft carries is written somewhere in the drawer", () => {
  const SOURCE = readFileSync(
    fileURLToPath(new URL("./ProfileDrawer.tsx", import.meta.url)),
    "utf8",
  );

  /**
   * `directory` is the first exception and it is deliberate: a profile is
   * filed from the moment it exists, so it is asked for by the sheet that
   * creates one and moved afterwards through the sharing sheet — which is the
   * drawer's *Who can use it*. There is no third place a thing changes hands.
   *
   * **Teams own delegation**, so there is no *Hands work off* control here
   * and there will not be one: a toggle sitting beside the teams that
   * actually decide it is read as the thing that decides it.
   *
   * What is here instead is the way out. `canDelegate` and `delegateScope`
   * are still carried by the draft and still written on every save, and
   * `OldReach` is the disclosure that appears **only** on a profile that
   * already carries some — a heading with the count, the owner's sentence,
   * and *Remove*, which sets both back. For a while a profile with reach set
   * could not be turned off from this window at all; that is what the
   * disclosure closes. It goes entirely with #497.
   *
   * `onChildLimit` is the one that really is nowhere. It is the Manager's own
   * half of the usage-limit grant and belongs with the teams work.
   */
  const ELSEWHERE = ["directory", "onChildLimit"];

  test("each one has a setter, or is named here as living elsewhere", () => {
    const missing = Object.keys(toDraft(REVIEWER))
      .filter((k) => !ELSEWHERE.includes(k))
      .filter(
        (k) =>
          !SOURCE.includes(`set("${k}"`) &&
          !SOURCE.includes(`${k}:`) &&
          !SOURCE.includes(`draft.${k}`),
      );
    expect(missing).toEqual([]);
  });

  /* And the two that are not fields at all. Neither is a row in the drawer
     any more: filing is the path chip in the header, which *is* the sharing
     sheet's control, and the default flag is the star on the list row, which
     is where the "only one" rule is visible rather than narrated. */
  test("the two that are not draft fields are still reachable", () => {
    expect(SOURCE).toContain("WhoCanAccess");
    expect(
      readFileSync(fileURLToPath(new URL("./Roles.tsx", import.meta.url)), "utf8"),
    ).toContain("setDefaultRole");
  });

  /* The actions the form's foot carried. Delete is the drawer's overflow and
     the library row; Save and Discard are the action row. */
  test("the form's own actions came across", () => {
    expect(SOURCE).toContain("deleteRole");
    expect(SOURCE).toContain("Save changes");
    expect(SOURCE).toContain("Discard");
  });
});

/* ── The reach a profile carried before teams ──────────────────────────── */

/**
 * **The one thing in this drawer that is drawn because of what is stored**,
 * rather than for every profile.
 *
 * A disclosure that appeared on every profile would teach the model being
 * removed to everybody who has never used it, which is the opposite of what
 * it is for. And on a profile that does carry reach it is the only way to put
 * it down from this window — the delegation controls came out when teams took
 * the question over, and the fields stayed live.
 */
describe("the old-reach disclosure", () => {
  const said = (over: Partial<Role>) =>
    renderToStaticMarkup(
      <OldReach
        draft={toDraft({ ...REVIEWER, ...over })}
        set={() => {}}
        roles={[
          { ...REVIEWER, id: "r_a", name: "Builder" },
          { ...REVIEWER, id: "r_b", name: "Scribe" },
        ]}
      />,
    );

  test("a profile with no reach is shown nothing at all", () => {
    expect(said({})).toBe("");
  });

  test("the heading carries the count, and the owner's sentence is untouched", () => {
    const out = said({ canDelegate: true, delegateScope: ["r_a", "r_b", "r_gone"] });
    expect(out).toContain("Still hands work to 3 profiles");
    expect(out).toContain(
      "We introduced the Teams feature which deprecated the old profile delegation feature.",
    );
    expect(out).toContain("Remove");
    expect(out).toContain("Show them");
  });

  /* An empty `delegate_scope` is the *wider* reach, not the absent one —
     "any the owner can see" — so it says so rather than counting to zero. */
  test("an empty scope is the wide case, and has nothing to show", () => {
    const out = said({ canDelegate: true, delegateScope: [] });
    expect(out).toContain("Still hands work to any profile you can see");
    expect(out).not.toContain("Show them");
  });

  /* Drawn for a scope held by a profile that was never turned off. */
  test("a scope on its own still shows, because it is still read", () => {
    expect(said({ canDelegate: false, delegateScope: ["r_a"] })).toContain(
      "Still hands work to 1 profile",
    );
  });

  /** And Remove is a change like any other: Save is the only commit here. */
  test("removing it is two fields, and the foot counts them", () => {
    const had = { ...REVIEWER, canDelegate: true, delegateScope: ["r_a"] };
    expect(diffOf(had, { ...toDraft(had), canDelegate: false, delegateScope: [] })).toEqual([
      "canDelegate",
      "delegateScope",
    ]);
  });
});

/* ── The three rows that went home ─────────────────────────────────────── */

/**
 * Each of the three had a sentence that existed because of where the control
 * was, which is the sharper form of this feature's copy rule: **a note that
 * narrates what the drawing already shows goes; a note that warns about
 * something invisible stays.** The sentences are the thing to test, because a
 * row can be moved and its explanation left behind.
 */
describe("the junk-drawer rows, and what went with them", () => {
  const SOURCE = readFileSync(
    fileURLToPath(new URL("./ProfileDrawer.tsx", import.meta.url)),
    "utf8",
  );

  test("Who can use it is gone, and the header chip is the control", () => {
    expect(SOURCE).not.toContain('label="Who can use it"');
    expect(SOURCE).not.toContain("Anyone who can reach the directory it is filed in.");
    expect(SOURCE).toMatch(/<WhoCanAccess[\s\S]*?className="dchip mono act"/);
  });

  test("Default is gone, and so is the rule a list makes visible", () => {
    expect(SOURCE).not.toContain("Only one profile can be the default");
    expect(SOURCE).not.toContain("Make this the default");
  });

  test("the engine is a named option rather than a blank value", () => {
    expect(SOURCE).toContain("ANY_ENGINE");
    expect(ANY_ENGINE).toBe("Any engine");
  });
});

/* ── What the tabs no longer explain ───────────────────────────────────── */

describe("the copy the drawer stopped carrying", () => {
  const SOURCE = readFileSync(
    fileURLToPath(new URL("./ProfileDrawer.tsx", import.meta.url)),
    "utf8",
  );

  /* Every pill carried this whether or not it was open — a counterfactual on
     an option nobody had taken. It is said once now, under the group, about
     the state that is actually set. */
  test("no pill carries the counterfactual any more", () => {
    expect(SOURCE).not.toContain("Leave it open and the lead decides");
    expect(SOURCE).not.toContain("here, unless the lead says otherwise");
    expect(SOURCE).toContain("The lead chooses the workspace when it delegates.");
    expect(SOURCE).toContain("A team or a lead can override this.");
  });

  /* The band above the body says the profile is shared, so a field under it
     saying the same thing is the second drawing of one fact. */
  test("nothing under the band repeats the band", () => {
    expect(SOURCE).not.toContain("The same in every team");
    expect(SOURCE).not.toContain("in {seat.teamName} only");
  });

  /* At rest the chip at the other end of the foot already reads No changes. */
  test("the foot says nothing when there is nothing to save", () => {
    expect(SOURCE).not.toContain("Saved. Workspaces already running keep what they started with.");
  });
});
