/**
 * The profile picker's empty state.
 *
 * **One control, two places.** `ProfileMenu` is what the composer drops from
 * its profile chip on the home page and the Dashboard, and now what the
 * schedules sheet drops too — so this copy and this button are everywhere
 * somebody meets an empty list, which is the point of them.
 *
 * It used to define the word: *a profile is a saved way of working — what it
 * is for, what it may do, and who it may hand work to*. That is no use to
 * somebody who has never made one. What they need is what profiles are for
 * and a way to get one, and making one is two choices on the Profiles page —
 * describe it to an agent, or fill in the form — which is not a thing to
 * reproduce inside a menu.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProfileMenu } from "~/ui/StartComposer";
import type { Role } from "~/api/generated/model";

const role = (id: string, name: string) =>
  ({ id, name, does: "Reads the dependency diff", canDelegate: false, placement: "new" }) as unknown as Role;

const draw = (profiles: Role[]) =>
  renderToStaticMarkup(<ProfileMenu profiles={profiles} profileId={null} onPick={() => {}} />);

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
});
