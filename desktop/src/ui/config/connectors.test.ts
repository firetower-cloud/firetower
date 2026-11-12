import { describe, expect, test } from "vitest";
import { PANES, paneAt } from "~/ui/config/panes";
import { destinationAt } from "~/ui/destinations";

/**
 * Where Connectors is, and that it is reachable.
 *
 * The position is a criterion rather than a preference — **Harness, directly
 * beneath Skills** — because the two answer halves of one question: a skill is
 * what an agent knows, a connector is what it can reach. A pane that drifted
 * into Code or Credentials would be filed by what it touches rather than by
 * what it is, which is the mistake `panes.ts`' own header is about.
 */
describe("where Connectors lives", () => {
  test("in Harness, directly beneath Skills", () => {
    const harness = PANES.find((g) => g.group === "Harness");
    expect(harness).toBeDefined();
    const at = harness!.items.map((i) => i.at);
    expect(at).toEqual(["agents", "roles", "skills", "connectors"]);
    expect(at.indexOf("connectors")).toBe(at.indexOf("skills") + 1);
  });

  test("called Connectors, because that is what Claude calls them too", () => {
    const row = PANES.flatMap((g) => g.items).find((i) => i.at === "connectors");
    expect(row?.label).toBe("Connectors");
  });

  /* A pane belongs either to a rail destination or to Settings' own index.
     Falling out of both is a pane reachable only by typing its address. */
  test("belongs to Customize, the destination Skills belongs to", () => {
    expect(destinationAt("/configuration/connectors")).toBe("customize");
    expect(destinationAt("/configuration/connectors")).toBe(
      destinationAt("/configuration/skills"),
    );
  });

  /* The address a sign-in prompt sends somebody to — `ConnectorNotice` and the
     picker both navigate to `/configuration/connectors/<id>`, and a pane that
     did not resolve that would land them on Repositories. */
  test("one connector has an address of its own", () => {
    expect(paneAt("/configuration/connectors/cx_01example")).toBe("connectors");
  });
});
