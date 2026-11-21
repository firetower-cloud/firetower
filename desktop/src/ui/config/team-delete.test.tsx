/**
 * What the confirmation says before a team is deleted.
 *
 * **This feature has produced two defects of exactly this shape already**, and
 * both were sentences rather than code: a confirmation that said no team held
 * a position when teams nobody could see did, and a count that read as
 * additive and so understated the damage *in the unsafe direction*. A
 * screenshot settles neither. So the three facts somebody acts on are pinned
 * here, with the singular of each, because the singular is the half that is
 * silently wrong.
 *
 * The three:
 *
 * - **how many positions go** — `AgentTeam.positions` counts the whole tree
 *   with the lead in it and is not filtered by what the reader can see, which
 *   is why it is the number used and `members` is not;
 * - **what happens to the schedules pinning it** — strictly worse than an
 *   edit, and it must not borrow the softer word;
 * - **that the profiles survive** — the one thing somebody fears, and the one
 *   thing that does not happen.
 */
import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentTeam } from "~/api/generated/model";
import { TeamBlast } from "./AgentTeams";

const team = (over: Partial<AgentTeam> = {}): AgentTeam => ({
  id: "at_1",
  name: "Growth",
  path: "u/kevin/growth",
  lead: "r_1",
  leadName: "Kevin",
  members: [],
  positions: 1,
  depth: 1,
  reports: 0,
  autoAdded: 0,
  schedules: 0,
  seeded: false,
  mayWrite: true,
  mayShare: true,
  createdAt: "",
  updatedAt: "",
  ...over,
});

/** The dialog's body as plain words, the way somebody reads it. */
const says = (over: Partial<AgentTeam> = {}) =>
  renderToStaticMarkup(<TeamBlast team={team(over)} />)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("the confirmation before a team is deleted", () => {
  test("it names the team and counts every position, the lead included", () => {
    expect(says({ positions: 7 })).toContain("deletes Growth and 7 positions in it, the lead included");
  });

  /* A team with only its lead is one position, not "1 positions" — and not
     nothing, because the lead's seat goes too. */
  test("a team that is only its lead still says one position goes", () => {
    expect(says({ positions: 1 })).toContain("1 position in it");
    expect(says({ positions: 1 })).not.toContain("1 positions");
  });

  /**
   * **The schedules, in the harder word.** `schedules/Pinned.tsx` says an
   * edit *pauses* them and one press starts each again. Deleting withdraws
   * the approval and leaves no team to approve, so borrowing "pause" here
   * would understate it in the unsafe direction — the same mistake this
   * feature has already made once with a count.
   */
  test("it says the schedules lose their approval, and that this is not a pause", () => {
    const said = says({ schedules: 4 });
    expect(said).toContain("4 schedules run as this team and lose their approval");
    expect(said).toContain("Editing a team pauses them");
    expect(said).toContain("This does not");
    expect(said).toContain("no team left to approve");
    expect(said).toContain("points them at another team");
  });

  test("one schedule reads as one, throughout the sentence", () => {
    const said = says({ schedules: 1 });
    expect(said).toContain("1 schedule runs as this team and loses its approval");
    expect(said).toContain("it refuses to run");
    expect(said).toContain("points it at another team");
    expect(said).not.toContain("1 schedules");
    expect(said).not.toContain("each refuses");
  });

  /* Nothing pinned, nothing said — rather than a sentence about zero
     schedules, which reads as a consequence where there is none. */
  test("a team no schedule pins says nothing about schedules", () => {
    const said = says({ schedules: 0 });
    expect(said).not.toContain("approval");
    expect(said).not.toContain("schedule");
  });

  /** Said every time, because it is the fear rather than the consequence. */
  test("it always says the profiles are not deleted", () => {
    for (const over of [{}, { schedules: 3 }, { positions: 9 }])
      expect(says(over)).toContain("The profiles are not deleted");
    expect(says()).toContain("stays in your library");
  });
});
