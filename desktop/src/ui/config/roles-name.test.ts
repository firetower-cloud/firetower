/**
 * A profile's name, against the directory it is filed in.
 *
 * The server is what enforces this — `roles_name_in_directory`, and the
 * sentences `crate::roles` reads off it — and the editor asks the same
 * question so that Save is not a button that looks live and comes back
 * refused. The two have to agree, which is why this is a test of the predicate
 * rather than of the screen.
 *
 * The three things that make it the *directory's* question and not the
 * installation's are all here: two directories may each hold an `Engineer`,
 * two people may each have a `Reviewer`, and a profile is never in its own
 * way. A check across everything visible would get the first two wrong — and a
 * check across everything that *exists* would be the enumeration oracle the
 * whole rule is scoped to avoid, since it would have to answer out of rows the
 * person asking cannot see.
 */
import { describe, expect, it } from "vitest";
import type { Role } from "~/api/generated/model";
import { filedIn, nameTakenBy, nameTakenSays } from "./profile-draft";

const profile = (id: string, name: string, path: string): Role =>
  ({ id, name, path, does: "does a thing" }) as Role;

/** Two of mine, one of Ana's, and two on a shelf. */
const ALL: Role[] = [
  profile("r_1", "Engineer", "u/kevin/engineer_01aaaaaa"),
  profile("r_2", "Reviewer", "u/kevin/reviewer_01bbbbbb"),
  profile("r_3", "Reviewer", "u/ana/reviewer_01cccccc"),
  profile("r_4", "engineer", "d/platform/engineer_01dddddd"),
  profile("r_5", "Architect", "d/research/architect_01eeeeee"),
];

describe("the directory a profile is filed in", () => {
  it("is the first two labels, whichever root it is under", () => {
    expect(filedIn("u/kevin/engineer_01aaaaaa")).toBe("u/kevin");
    expect(filedIn("d/platform/engineer_01dddddd")).toBe("d/platform");
    // Everything after the root is a name with separators in it, and is filed
    // in `platform` all the same.
    expect(filedIn("d/platform/team/engineer")).toBe("d/platform");
  });
});

describe("whether a profile's name is free where it is being filed", () => {
  it("refuses a name already there, case-insensitively, and names the one that has it", () => {
    expect(nameTakenBy("engineer", "u/kevin", undefined, ALL)).toBe("Engineer");
    expect(nameTakenBy("ENGINEER", "u/kevin", undefined, ALL)).toBe("Engineer");
    expect(nameTakenBy("  Engineer  ", "u/kevin", undefined, ALL)).toBe("Engineer");
    // The name as it is stored, not as it was typed: that is the profile they
    // will find on the screen.
    expect(nameTakenBy("Engineer", "d/platform", undefined, ALL)).toBe("engineer");
  });

  it("accepts the same name in another directory", () => {
    expect(nameTakenBy("Engineer", "d/research", undefined, ALL)).toBe(null);
    expect(nameTakenBy("Architect", "u/kevin", undefined, ALL)).toBe(null);
  });

  it("accepts a name somebody else has in their own space", () => {
    // Ana's `Reviewer` is not in the way of a `Reviewer` in a directory, and
    // would not be in the way of one of mine either.
    expect(nameTakenBy("Reviewer", "d/platform", undefined, ALL)).toBe(null);
    expect(nameTakenBy("Reviewer", "u/ana", undefined, ALL)).toBe("Reviewer");
  });

  it("never puts a profile in its own way", () => {
    // Saving a profile without touching its name is most of what the editor
    // does, so this is the ordinary case rather than a corner.
    expect(nameTakenBy("Engineer", "u/kevin", "r_1", ALL)).toBe(null);
    // And the other one still is.
    expect(nameTakenBy("Reviewer", "u/kevin", "r_1", ALL)).toBe("Reviewer");
  });

  /* No opinion rather than a guess. The destination is unknown until `useMe()`
     answers — a new profile in your own space needs your own root spelled, and
     reading a `u/` prefix as *mine* is the mistake this repository has already
     made four times. The server still refuses what this cannot see. */
  it("says nothing while the destination is unknown", () => {
    expect(nameTakenBy("Engineer", null, undefined, ALL)).toBe(null);
    expect(nameTakenBy("", "u/kevin", undefined, ALL)).toBe(null);
    expect(nameTakenBy("   ", "u/kevin", undefined, ALL)).toBe(null);
  });
});

describe("what it says", () => {
  it("is about you in your own space, and about the directory otherwise", () => {
    expect(nameTakenSays("Engineer", "yours")).toContain("You already have a profile");
    expect(nameTakenSays("Engineer", "d/platform")).toContain("already filed in d/platform");
    // Both of them say why, because the name is not the thing at fault.
    for (const chip of ["yours", "d/platform"]) {
      expect(nameTakenSays("Engineer", chip)).toContain("can’t share a name");
    }
  });
});
