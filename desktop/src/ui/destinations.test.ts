import { describe, expect, test } from "vitest";
import { SETTINGS, SETTINGS_HOME, SETTINGS_PANES } from "~/ui/config/panes";
import { DESTINATIONS, destinationAt } from "./destinations";

describe("the rail's own shape", () => {
  /* Six, and nothing under them. Settings and Updates used to be two doors
     below a rule, keyless because they were doors rather than destinations;
     they are rows in the profile menu now and nothing else. */
  test("six destinations, each on its own number", () => {
    expect(DESTINATIONS).toHaveLength(6);
    expect(DESTINATIONS.map((d) => d.key)).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  /* What the keyless doors used to prove, from the other side: a place in the
     rail now always has a number, which is what stops a seventh keyless icon
     being added back without the argument being had again. */
  test("nothing in the rail is keyless, and nothing in it is Settings or Updates", () => {
    expect(DESTINATIONS.every((d) => !!d.key)).toBe(true);
    expect(DESTINATIONS.map((d) => d.id)).not.toContain("settings");
    expect(DESTINATIONS.map((d) => d.id)).not.toContain("updates");
  });
});

/**
 * The two tables that between them have to name every pane.
 *
 * A pane belongs either to a destination (`PANE_HOME`, read through
 * `destinationAt`) or to Settings (`SETTINGS` in `config/panes.ts`). Falling
 * out of both is a pane with no rail icon *and* no row in Settings' index:
 * reachable only by typing its address, which nobody will.
 */
describe("Settings' own index", () => {
  test("holds exactly the panes no destination owns", () => {
    expect(SETTINGS_PANES).toEqual(["people", "teams", "directories", "vault", "server"]);
    for (const at of SETTINGS_PANES) expect(destinationAt(`/configuration/${at}`)).toBeNull();
  });

  /* The grouping is the part that survived the move out of the rail panel
     unchanged, so it is the part worth pinning. */
  test("keeps the three groups the rail panel drew", () => {
    expect(SETTINGS.map((g) => g.group)).toEqual(["Who can reach what", "Secrets", "This deployment"]);
  });

  test("opens on its first pane, which is where ⌘, lands", () => {
    expect(SETTINGS_HOME).toBe("/configuration/people");
  });
});

describe("which destination a path is in", () => {
  test("the six, from their own addresses", () => {
    expect(destinationAt("/")).toBe("home");
    expect(destinationAt("/tasks")).toBe("tasks");
    expect(destinationAt("/artifacts")).toBe("artifacts");
  });

  /* A detail screen keeps its destination's rail mark: you are still in
     Dashboard when you are reading one workspace, and still in Customize when
     you are reading one skill. */
  test("a workspace is still the Dashboard", () => {
    expect(destinationAt("/sessions/w_1")).toBe("home");
    expect(destinationAt("/new")).toBe("home");
  });

  /* The twelve configuration panes used to be one screen behind one rail
     entry. Seven of them now belong to the destination they are about. */
  test("every configuration pane a destination owns", () => {
    expect(destinationAt("/configuration/skills")).toBe("customize");
    expect(destinationAt("/configuration/roles")).toBe("customize");
    expect(destinationAt("/configuration/agents")).toBe("customize");
    expect(destinationAt("/configuration/repositories")).toBe("repos");
    expect(destinationAt("/configuration/git-hosts")).toBe("repos");
    expect(destinationAt("/configuration/machines")).toBe("machines");
    expect(destinationAt("/configuration/trackers")).toBe("tasks");
  });

  /* **And Settings' five own none of the six.** These answered "settings"
     while Settings was the seventh icon in the rail. Lighting a work surface
     for a screen that is reached from the profile menu would say you are
     somewhere you are not, so the rail marks nothing and Settings' own index
     says where you are. */
  test("Settings' own panes light no destination", () => {
    expect(destinationAt("/configuration/people")).toBeNull();
    expect(destinationAt("/configuration/teams")).toBeNull();
    expect(destinationAt("/configuration/directories")).toBeNull();
    expect(destinationAt("/configuration/vault")).toBeNull();
    expect(destinationAt("/configuration/server")).toBeNull();
  });

  /* An address from an older build, or one somebody typed. It resolves the way
     `Configuration.tsx` resolves it — through `paneAt`, which falls back to
     Repositories rather than drawing an empty screen — so the mark agrees with
     the pane on screen. It used to answer "settings" for both of these while
     the page drew Repositories. */
  test("a pane nobody recognises lights whoever owns the pane it falls back to", () => {
    expect(destinationAt("/configuration/nonsense")).toBe("repos");
    expect(destinationAt("/configuration")).toBe("repos");
    expect(destinationAt("/configuration/integrations")).toBe("repos");
  });

  /* The screens that are nobody's. Lighting the Dashboard for the account
     screen would say you are somewhere you are not. */
  test("and the screens that belong to no destination say so", () => {
    expect(destinationAt("/account")).toBeNull();
    expect(destinationAt("/connect")).toBeNull();
    expect(destinationAt("/setup")).toBeNull();
    expect(destinationAt("/style")).toBeNull();
    /* Updates joined them when its door went. It is a row in the profile
       menu, and a mark on the avatar above it — neither is a rail icon. */
    expect(destinationAt("/updates")).toBeNull();
  });
});
