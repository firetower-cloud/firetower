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
  InTeams,
  PROFILE_TABS,
  ProfileDrawer,
  SEAT_TABS,
  SHARED,
  diffOf,
  notSaved,
  willSave,
  type SeatHandle,
} from "./ProfileDrawer";
import { toDraft } from "./profile-draft";

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
  const says = (used: ProfilePosition[]) =>
    renderToStaticMarkup(<Blast name="Engineer" used={used} />).replace(/<[^>]+>/g, " ");

  test("a profile no team uses says that, rather than a count of nothing", () => {
    const said = says([]);
    expect(said).toContain("No team holds a position for it");
    expect(said).not.toContain("0 positions");
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
    expect(said).toContain("This removes 4 positions from 2 teams");
  });

  /** Two seats in one team are one row, and the counts add up. */
  test("two seats in one team are counted together under that team's name", () => {
    const said = says([
      sits({ position: "p_1", takes: 2 }),
      sits({ position: "p_2", takes: 1 }),
    ]);
    expect(said).toContain("This removes 3 positions from one team");
    expect(said).toContain("loses 3 positions");
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
    expect(willSave(1, 1)).toBe("Will save 1 change to the profile.");
    expect(willSave(2, 0)).toBe("Will save 2 changes to the profile.");
  });

  test("more than one is counted, because the others are not on screen", () => {
    expect(willSave(1, 2)).toBe("Will save 1 change to the profile, in both teams that use it.");
    expect(willSave(3, 4)).toBe("Will save 3 changes to the profile, in all 4 teams that use it.");
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
   * And the fact the marking rests on. *In teams* holds the reach a profile
   * carries on its own, which is live for the whole compatibility window — so
   * it writes profile fields, and a band saying otherwise is false.
   */
  test("In teams writes profile fields, which is why it is shared", () => {
    const written: string[] = [];
    const drawn = renderToStaticMarkup(
      <InTeams
        role={REVIEWER}
        draft={{ ...toDraft(REVIEWER), canDelegate: true }}
        set={(k) => written.push(k as string)}
        all={[REVIEWER]}
        places={[]}
        loading={false}
        here={null}
      />,
    );
    expect(SHARED.where).toBe(true);
    expect(drawn).toContain("Hands work off");
    expect(drawn).toContain("When a child runs out");
    expect(written).toEqual([]);
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
        draft={toDraft(REVIEWER)}
        set={() => {}}
        all={[REVIEWER]}
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
   * `directory` is the one exception and it is deliberate: a profile is filed
   * from the moment it exists, so it is asked for by the sheet that creates
   * one and moved afterwards through the sharing sheet — which is the drawer's
   * *Who can use it*. There is no third place a thing changes hands.
   */
  const ELSEWHERE = ["directory"];

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

  /* And the two that are not fields at all: the default flag writes on the
     press through its own endpoint, and filing is the sharing sheet's. */
  test("the two that are not draft fields are still reachable", () => {
    expect(SOURCE).toContain("setDefaultRole");
    expect(SOURCE).toContain("WhoCanAccess");
  });

  /* The actions the form's foot carried. Delete is the drawer's overflow and
     the library row; Save and Discard are the action row. */
  test("the form's own actions came across", () => {
    expect(SOURCE).toContain("deleteRole");
    expect(SOURCE).toContain("Save changes");
    expect(SOURCE).toContain("Discard");
  });
});
