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
  /* **Usage, and it is called Usage rather than Spend.** *Spend* is the
     specification's feature name; the interface has said Usage since the
     screen was written, the route it came from is `/organization/usage`, and
     the figure on it is tokens rather than money — a pane called Spend with no
     currency on it raises a question the screen cannot answer.

     Its own group because it is the only pane here that is about what
     happened rather than about who may do what: *What it cost* is the sketch's
     own label, and it is what the Organisation panel writes over the row. */
  { group: "What it cost", items: [{ at: "usage", label: "Usage" }] },
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
 * **It is down to one pane, in two steps.** "Who can reach what" went first,
 * with People, Teams and Directories, when the Organisation destination was
 * made — they were only ever here because they had no destination to belong
 * to. Then "This deployment" went the same way: the deployment pane is the
 * organisation's installation, it is an administrator's, and it belongs beside
 * the organisation's people rather than in a list of leftovers.
 *
 * What is left is the Vault, and it is here for a reason rather than by
 * subtraction: a secret is held *by* this installation for whoever can reach
 * it, so it is neither a work surface nor an organisation-shaped thing. It is
 * the one pane that was never anybody else's.
 *
 * `destinations.test.ts` asserts these are exactly the panes missing from
 * `PANE_HOME`, so a pane cannot quietly belong to neither table and become
 * unreachable.
 */
export const SETTINGS: { group: string; items: { at: string; label: string }[] }[] = [
  { group: "Secrets", items: [{ at: "vault", label: "Vault" }] },
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
 * **It is Vault, and it was re-checked when Settings came down to one pane.**
 * It was chosen over *This Firetower* on the argument that a secret is a thing
 * somebody goes to while a facts pane is read once; *This Firetower* has since
 * left for the Organisation destination, so the argument is moot and the
 * answer is unchanged. That is the whole value of naming it: the list shrank
 * by half and `⌘,` did not move.
 *
 * **And it is not People**, which is the other half of the decision. People
 * has a rail icon, a number key and a panel; a `⌘,` that also landed there
 * would be Settings and Organisation drawn as two doors onto one room — the
 * exact defect that took the Settings door out of the rail in the first place
 * (`destinations.ts` carries that argument), arriving back from the other
 * side.
 *
 * **A one-pane index is not an index**, and `SettingsIndex` draws nothing
 * while that is true — see its own note. What `⌘,` means does not depend on
 * that: it is this constant, and it would still be this constant if a second
 * pane arrived tomorrow.
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
