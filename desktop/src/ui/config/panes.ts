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
    items: [
      { at: "machines", label: "Machines" },
      { at: "agents", label: "Agents" },
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
