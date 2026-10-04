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
 * badly by output: GitHub gives code *and* work, a tracker gives only work, and
 * the next git host will give only code.
 */
export const PANES: { group: string; items: { at: string; label: string }[] }[] = [
  {
    group: "Setup",
    items: [
      { at: "integrations", label: "Integrations" },
      { at: "repositories", label: "Repositories" },
    ],
  },
  {
    group: "Compute",
    items: [
      { at: "machines", label: "Machines" },
      { at: "agents", label: "Agents" },
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

export const FIRST = "integrations";

/** Which pane a path means, falling back rather than drawing nothing. */
export function paneAt(path: string): string {
  const asked = path.split("/").filter(Boolean)[1];
  return PANES.some((g) => g.items.some((i) => i.at === asked)) ? (asked as string) : FIRST;
}
