import { describe, expect, test } from "vitest";
import { SETTINGS, SETTINGS_HOME, SETTINGS_PANES } from "~/ui/config/panes";
import { DESTINATIONS, destinationAt } from "./destinations";

describe("the rail's own shape", () => {
  /* Eight, and nothing under them. Settings and Updates used to be two doors
     below a rule, keyless because they were doors rather than destinations;
     they are rows in the profile menu now and nothing else. */
  test("eight destinations, each on its own number", () => {
    expect(DESTINATIONS).toHaveLength(8);
    expect(DESTINATIONS.map((d) => d.key)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
  });

  /**
   * **The order, written down, because it is the keyboard's.**
   *
   * Schedules sits after Customize: the rail reads as what is happening and
   * then what is set up, and a schedule is closer to a thing you set up than
   * to a machine. It shipped appended at `⌘7` first, on the argument that
   * these numbers do not move; it was moved once both arrangements had been
   * seen, and Repositories and Machines went down one with it.
   *
   * What this test is for has not changed — a destination slipped into the
   * middle moves everybody's keys, so moving one is a deliberate act that
   * includes editing this list.
   */
  test("the rail is in the order the keyboard is", () => {
    expect(DESTINATIONS.map((d) => [d.id, d.key])).toEqual([
      ["home", "1"],
      ["tasks", "2"],
      ["artifacts", "3"],
      ["customize", "4"],
      ["schedules", "5"],
      ["repos", "6"],
      ["machines", "7"],
      ["organisation", "8"],
    ]);
  });

  /**
   * **Organisation was appended, and that is the whole point of it.**
   *
   * Schedules was inserted at `⌘5` and moved two destinations down with it —
   * a cost `destinations.ts` records as paid once, deliberately. Paying it
   * again two releases later is what makes a numbered rail something people
   * stop learning, so this pins the seven that were already here to the
   * numbers they already had, independently of the list above.
   */
  test("appending the eighth renumbered none of the seven", () => {
    const keys = Object.fromEntries(DESTINATIONS.map((d) => [d.id, d.key]));
    expect(keys.home).toBe("1");
    expect(keys.tasks).toBe("2");
    expect(keys.artifacts).toBe("3");
    expect(keys.customize).toBe("4");
    expect(keys.schedules).toBe("5");
    expect(keys.repos).toBe("6");
    expect(keys.machines).toBe("7");
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
  /**
   * **Three fewer than it held.** People, Teams and Directories are
   * Organisation's panes now, so they are expected to be *absent* here and
   * present in `PANE_HOME` — which the loop below is the other half of. The
   * cross-check is unchanged and is the thing that matters: every pane belongs
   * to exactly one of the two tables, and a pane in neither is reachable only
   * by typing its address.
   */
  test("holds exactly the panes no destination owns", () => {
    expect(SETTINGS_PANES).toEqual(["vault"]);
    for (const at of SETTINGS_PANES) expect(destinationAt(`/configuration/${at}`)).toBeNull();
  });

  /* Down to one, in two steps: "Who can reach what" went with People, Teams
     and Directories, then "This deployment" followed the deployment pane into
     Organisation. The Vault is what is left, and it is left for a reason
     rather than by subtraction — a secret is held *by* the installation for
     whoever can reach it, so it was never anybody else's. */
  test("keeps the one group whose pane stayed", () => {
    expect(SETTINGS.map((g) => g.group)).toEqual(["Secrets"]);
  });

  /**
   * **`⌘,` is Vault, and it is named rather than counted.**
   *
   * `SETTINGS_HOME` was the *first pane in this list*, which meant that moving
   * People out changed what `⌘,`, the profile menu's Settings row and the
   * palette's Settings command all mean — three entry points, at once, by
   * array order rather than by anybody's decision. `panes.ts` names the pane
   * now, so reordering the index moves rows in an index and nothing else.
   *
   * Vault because it is the one of the two somebody goes to: a secret is
   * added, replaced and taken away, where *This Firetower* is read once. And
   * **not People** — People has a rail icon and `⌘8` now, and a `⌘,` that also
   * landed there would draw Settings and Organisation as two doors onto one
   * room, which is the defect that took the Settings door out of the rail.
   */
  test("opens on Vault, which is where ⌘, lands", () => {
    expect(SETTINGS_HOME).toBe("/configuration/vault");
  });

  /* And it has to be a pane this index actually draws, or ⌘, lands somewhere
     with no way back out of it. */
  test("and ⌘, lands on a pane the index lists", () => {
    expect(SETTINGS_PANES).toContain(SETTINGS_HOME.split("/").pop());
  });
});

describe("which destination a path is in", () => {
  test("the first three, from their own addresses", () => {
    expect(destinationAt("/")).toBe("home");
    expect(destinationAt("/tasks")).toBe("tasks");
    expect(destinationAt("/artifacts")).toBe("artifacts");
  });

  /* And the seventh, including one schedule opened — the rail stays lit on
     Schedules while any of its routes is open, the way it stays lit on
     Customize while you read one skill. */
  test("every schedules route is the Schedules destination", () => {
    expect(destinationAt("/schedules")).toBe("schedules");
    expect(destinationAt("/schedules/sch_1")).toBe("schedules");
    expect(destinationAt("/schedules/runs")).toBe("schedules");
  });

  /* A detail screen keeps its destination's rail mark: you are still in
     Dashboard when you are reading one workspace, and still in Customize when
     you are reading one skill. */
  test("a workspace is still the Dashboard", () => {
    expect(destinationAt("/sessions/w_1")).toBe("home");
    expect(destinationAt("/new")).toBe("home");
  });

  /* The twelve configuration panes used to be one screen behind one rail
     entry. Ten of them now belong to the destination they are about. */
  test("every configuration pane a destination owns", () => {
    expect(destinationAt("/configuration/plugins")).toBe("customize");
    expect(destinationAt("/configuration/roles")).toBe("customize");
    expect(destinationAt("/configuration/agents")).toBe("customize");
    expect(destinationAt("/configuration/repositories")).toBe("repos");
    expect(destinationAt("/configuration/git-hosts")).toBe("repos");
    expect(destinationAt("/configuration/machines")).toBe("machines");
    expect(destinationAt("/configuration/trackers")).toBe("tasks");
  });

  /**
   * **The three that moved, and the rail lights for all three.**
   *
   * They answered `null` while they were Settings' — which was right then, and
   * is the thing that changed. A member pressing `⌘8` has to land on a
   * destination that is lit, on a pane that is populated; a rail that marks
   * nothing while People is on screen would say the pane belongs to nobody.
   */
  test("People, Teams and Directories are the Organisation destination", () => {
    expect(destinationAt("/configuration/people")).toBe("organisation");
    expect(destinationAt("/configuration/teams")).toBe("organisation");
    expect(destinationAt("/configuration/directories")).toBe("organisation");
  });

  /**
   * **And so is the deployment pane, for everybody who reaches the address.**
   *
   * Which destination owns a pane and whether a pane is *listed* are two
   * questions with two answers: this table says the first, and
   * `config/organisation.ts`'s `panesFor` says the second. The rail has to
   * light the same icon either way — somebody who typed an address that used
   * to be Settings' gets a destination that makes sense, and what they are
   * drawn is `Configuration.tsx`'s business.
   */
  test("the deployment pane is the Organisation destination too", () => {
    expect(destinationAt("/configuration/server")).toBe("organisation");
  });

  /* **And the Vault owns none of the eight.** Lighting a work surface for a
     screen reached from the profile menu would say you are somewhere you are
     not, so the rail marks nothing. */
  test("Settings' own pane lights no destination", () => {
    expect(destinationAt("/configuration/vault")).toBeNull();
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
