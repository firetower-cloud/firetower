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
      // Directly after Profiles, because it is the other half of the same
      // idea: a profile is what an agent is, and a team is where it sits and
      // who is under it. `agent-teams`, never `teams` — that one is teams of
      // *people* and is in the Access group below.
      { at: "agent-teams", label: "Agent teams" },
      { at: "skills", label: "Skills" },
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
 * Settings' own index — the panes no destination owns.
 *
 * This was the list the rail panel drew while Settings was a door in the rail,
 * relocated into the page unchanged: taking the door out of the rail took the
 * only way to move between the panes with it, so `SettingsIndex` draws this at
 * the top of every one of them.
 *
 * **"Who can reach what" has gone, with all three of its panes.** People,
 * Teams and Directories are the Organisation destination's now — see
 * `destinations.ts` — and they were only ever here because they had no
 * destination to belong to. What is left is the two groups that are genuinely
 * nobody's work surface: the secrets this installation holds, and the
 * installation itself.
 *
 * **The group names are not `PANES`' group names, and that is deliberate.**
 * `PANES` above groups by what a thing *is*, because it is the table that says
 * what a valid pane is. These say what the group is *for* — "This deployment"
 * rather than "Server" — because they are read by somebody looking for a thing
 * to change, and a category word does not help them.
 *
 * `destinations.test.ts` asserts these are exactly the panes missing from
 * `PANE_HOME`, so a pane cannot quietly belong to neither table and become
 * unreachable.
 */
export const SETTINGS: { group: string; items: { at: string; label: string }[] }[] = [
  { group: "Secrets", items: [{ at: "vault", label: "Vault" }] },
  { group: "This deployment", items: [{ at: "server", label: "This Firetower" }] },
];

/** Every pane Settings owns, flat, in the order the index draws them. */
export const SETTINGS_PANES = SETTINGS.flatMap((g) => g.items.map((i) => i.at));

/**
 * Which pane `⌘,` means — **named, not the first row of a list**.
 *
 * `SETTINGS_HOME` was `SETTINGS_PANES[0]`, and that was fine for exactly as
 * long as the list did not change. Three things navigate by it — `⌘,` in
 * `Rail.tsx`, the profile menu's Settings row, and the palette's Settings
 * command — so the moment People, Teams and Directories left this list, all
 * three silently changed meaning at once, **by array order rather than by
 * anybody's decision**. That is the failure this constant exists to make
 * impossible: reordering `SETTINGS` now moves rows in an index and nothing
 * else.
 *
 * **It is Vault.** Of the two panes left, Vault is the one somebody *goes* to:
 * a secret is added, replaced and taken away, and a deployment that is holding
 * credentials is holding them for a reason somebody comes back to. *This
 * Firetower* is a facts pane — an address, a version, who you are signed in as
 * — plus a Disconnect that is pressed once ever. Landing on the thing you read
 * once would make `⌘,` feel like it went nowhere.
 *
 * **And it is not People any more**, which is the other half of the decision.
 * People now has a rail icon, a number key and a panel; a `⌘,` that also
 * landed there would be Settings and Organisation drawn as two doors onto one
 * room — which is the exact defect that took the Settings door out of the rail
 * in the first place (`destinations.ts` carries that argument), arriving back
 * from the other side.
 */
const SETTINGS_OPENS_ON = "vault";

/**
 * Where Settings opens.
 *
 * Rather than a `/configuration` index — there is no index screen, and there
 * has not been one since the panes got destinations. `⌘,`, the profile menu's
 * Settings row and the palette's Settings command all land here, so there is
 * one answer to "what does Settings mean" rather than three.
 */
export const SETTINGS_HOME = `/configuration/${SETTINGS_OPENS_ON}`;

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
