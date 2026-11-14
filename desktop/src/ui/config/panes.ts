/**
 * The configuration index, and the only place its order is decided.
 *
 * Here rather than in `Configuration.tsx` because two files need it: the pane
 * decides what to draw, and the rail draws the index itself — configuration
 * *replaces* the workspaces rather than standing a second column beside them.
 *
 * Grouped by what a thing *is*, not by what it produces. An earlier draft put
 * Integrations and Repositories under "Sources", which reads as a promise that
 * both feed the same pipe — and Linear yields no repositories. Services divide
 * badly by output: a git host gives code *and* work, a tracker gives only work.
 *
 * **Integrations was two jobs under one word.** Git hosts are what you clone
 * and push with; trackers are where you read work from. Sharing a pane meant
 * every git host was drawn twice — once to connect, once in the tracker list
 * saying "connects above" — so three hosts filled six rows with three things,
 * and the tracker half was pushed off the bottom as hosts were added.
 *
 * **Repositories goes first and is where Configuration opens.** It is the job;
 * the hosts underneath it are the prerequisite, touched once. That only works
 * because the Repositories screen can connect a host on its own — see `Repos`
 * — so landing there with nothing set up is a start rather than a dead end.
 */
export const PANES: { group: string; items: { at: string; label: string }[] }[] = [
  {
    group: "Code",
    items: [
      { at: "repositories", label: "Repositories" },
      { at: "git-hosts", label: "Git hosts" },
    ],
  },
  { group: "Work", items: [{ at: "trackers", label: "Trackers" }] },
  {
    group: "Compute",
    items: [{ at: "machines", label: "Machines" }],
  },
  {
    // What shapes how an agent runs, rather than where. Firetower is a harness
    // for coding agents; this is the part of it you configure — the agents it
    // can run, the profiles they take on and delegate to, and the skills they
    // can read.
    group: "Harness",
    items: [
      // The connected accounts — Claude Code, Codex, Kimi — an agent runs on.
      { at: "agents", label: "Agents" },
      // The saved personas any agent can run — a lead, a developer, a reviewer,
      // a QA — and the teams between them. "Profiles" to the person, because one
      // is worn by a workspace's own agent as much as by a delegate; `roles` on
      // the wire, because the API and the spawn tool still say role.
      { at: "roles", label: "Profiles" },
      { at: "skills", label: "Skills" },
      // Beneath Skills, and in this group, because a connector is the other
      // half of the same question: a skill is what an agent knows, a connector
      // is what it can reach. Both are things you turn on for a session, both
      // cost context on every turn, and both are read by the same picker.
      { at: "connectors", label: "Connectors" },
    ],
  },
  {
    group: "Access",
    items: [
      { at: "people", label: "People" },
      { at: "teams", label: "Teams" },
      { at: "directories", label: "Directories" },
    ],
  },
  { group: "Credentials", items: [{ at: "vault", label: "Vault" }] },
  { group: "Server", items: [{ at: "server", label: "This Firetower" }] },
];

/**
 * Settings' own index — the five panes no destination owns.
 *
 * This is the list the rail panel drew while Settings was a door in the rail,
 * moved **unchanged**: the same five panes, the same order, the same three
 * group names. Taking the door out of the rail took the only way to move
 * between them with it, so the index comes into the page — `SettingsIndex`
 * draws it at the top of every one of these panes.
 *
 * **The group names are not `PANES`' group names, and that is deliberate.**
 * `PANES` above groups by what a thing *is*, because it is the table that says
 * what a valid pane is. These three say what the group is *for* — "Who can
 * reach what" rather than "Access" — because they are read by somebody looking
 * for a thing to change, and a category word does not help them. Two names for
 * one group is a cost; a reader guessing which of nine panes holds the
 * directory list is a bigger one.
 *
 * `destinations.test.ts` asserts these are exactly the panes missing from
 * `PANE_HOME`, so a pane cannot quietly belong to neither table and become
 * unreachable.
 */
export const SETTINGS: { group: string; items: { at: string; label: string }[] }[] = [
  {
    group: "Who can reach what",
    items: [
      { at: "people", label: "People" },
      { at: "teams", label: "Teams" },
      { at: "directories", label: "Directories" },
    ],
  },
  { group: "Secrets", items: [{ at: "vault", label: "Vault" }] },
  { group: "This deployment", items: [{ at: "server", label: "This Firetower" }] },
];

/** Every pane Settings owns, flat, in the order the index draws them. */
export const SETTINGS_PANES = SETTINGS.flatMap((g) => g.items.map((i) => i.at));

/**
 * Where Settings opens.
 *
 * Its first pane, rather than a `/configuration` index — there is no index
 * screen, and there has not been one since the panes got destinations. ⌘,, the
 * profile menu's Settings row and the palette's Settings command all land here,
 * so there is one answer to "what does Settings mean" rather than three.
 */
export const SETTINGS_HOME = `/configuration/${SETTINGS_PANES[0]}`;

/** Whether a path is on one of Settings' own panes. */
export function inSettings(path: string): boolean {
  return path.startsWith("/configuration") && SETTINGS_PANES.includes(paneAt(path));
}

/**
 * What a path from before the split means now.
 *
 * `integrations` was one pane and is two. An address in somebody's history, or
 * a link in a message, should land somewhere sensible rather than falling back
 * to the first pane — and the git hosts are what that word mostly meant.
 */
const MOVED: Record<string, string> = { integrations: "git-hosts" };

export const FIRST = "repositories";

/** Which pane a path means, falling back rather than drawing nothing. */
export function paneAt(path: string): string {
  const asked = path.split("/").filter(Boolean)[1] ?? "";
  if (PANES.some((g) => g.items.some((i) => i.at === asked))) return asked;
  return MOVED[asked] ?? FIRST;
}
